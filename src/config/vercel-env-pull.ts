/**
 * Vercel API env pull — single source of truth for v3 env vars.
 *
 * Why: pre-2026-06-02 the v3 daemon read env from
 *   /home/plyne/Desktop/Projects/plyne-v3/.env
 * which could drift vs Vercel (the source-of-truth for every other
 * GMR product). The 1923-pm2-restart incident was rooted in exactly
 * this drift — NOTION_TOKEN had been rotated on Vercel but the VPS .env
 * was stale, so the daemon held an invalid token without anyone realising.
 *
 * This module pulls env vars from the Vercel API at boot, **before** the
 * Zod env schema runs, so `process.env` is hydrated with the canonical
 * Vercel values. The .env file becomes a *fallback* (offline / token-
 * missing) instead of the primary source.
 *
 * Behaviour:
 *   - Gated by `PLYNE_V3_PULL_VERCEL_ENV=true`. Default off — explicit opt-in
 *     so existing local-dev workflows aren't perturbed.
 *   - Requires `VERCEL_TOKEN` in the local environment (typically loaded
 *     from `.env` via dotenv before this runs).
 *   - Project ID hard-wired to `prj_ga3mQEEC546h5afE8d2g3oo95DCl`
 *     (plyne-evidence) — see VERCEL_PROJECT_ID constant below.
 *   - On Vercel API failure: logs the error and returns. The caller
 *     proceeds with whatever's already in `process.env` (i.e. the .env
 *     file via dotenv), so the daemon stays resilient + offline-friendly.
 *   - Does NOT overwrite a `process.env` value that's already set by the
 *     parent shell — that's an explicit operator override (rare, debug).
 *
 * Boot order (see src/index.ts):
 *   1. `dotenv/config` is loaded *manually* (not the side-effect import).
 *      This gives us VERCEL_TOKEN.
 *   2. `pullVercelEnv()` runs — populates process.env from Vercel.
 *   3. `loadEnv()` (Zod) runs — validates the merged result.
 *   4. Boot validation (api keys live-pings, dirs, etc.) runs.
 *   5. API + runner start.
 */

const VERCEL_PROJECT_ID = "prj_ga3mQEEC546h5afE8d2g3oo95DCl"; // plyne-evidence
const VERCEL_API_BASE = "https://api.vercel.com";

/** Which Vercel deployment environment to pull from. Production matches the
 *  daemon's role (24/7, real workloads). Operators can override via
 *  `PLYNE_V3_VERCEL_ENV_TARGET` if a debug "preview" pull is needed. */
const DEFAULT_TARGET = "production";

interface VercelEnvVar {
  key: string;
  value: string;
  target: string[];
  type: string;
}

interface VercelEnvResponse {
  envs: VercelEnvVar[];
}

export interface PullResult {
  /** True when the pull ran (gate on, no fatal error). False when gated off
   *  or skipped due to missing VERCEL_TOKEN. */
  ran: boolean;
  /** Keys that ended up in process.env *because of* this pull (i.e. they were
   *  unset before, and Vercel had a value). */
  fromVercel: string[];
  /** Keys that were already set in process.env before the pull (parent shell
   *  or .env file) — we never override these. Surfaced for boot-log clarity. */
  preservedLocal: string[];
  /** Keys present in Vercel but with empty string values — skipped to avoid
   *  blanking a healthy local default. */
  emptyFromVercel: string[];
  /** Non-fatal error message if the API call failed; null on success. */
  error: string | null;
}

/**
 * Pull env vars from the Vercel API and merge them into `process.env`.
 *
 * Idempotent: re-running is a no-op if `process.env` already has the keys.
 * Safe to call from a boot path — never throws (errors are returned in
 * `PullResult.error`).
 */
export async function pullVercelEnv(): Promise<PullResult> {
  const gate = process.env.PLYNE_V3_PULL_VERCEL_ENV;
  if (gate !== "true" && gate !== "1") {
    return {
      ran: false,
      fromVercel: [],
      preservedLocal: [],
      emptyFromVercel: [],
      error: null
    };
  }

  const token = process.env.VERCEL_TOKEN;
  if (!token || token.trim() === "") {
    return {
      ran: false,
      fromVercel: [],
      preservedLocal: [],
      emptyFromVercel: [],
      error: "VERCEL_TOKEN missing — cannot pull from Vercel; falling back to local .env"
    };
  }

  const target = process.env.PLYNE_V3_VERCEL_ENV_TARGET || DEFAULT_TARGET;
  const teamParam = process.env.VERCEL_TEAM_ID
    ? `&teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}`
    : "";
  // `decrypt=true` is required — Vercel returns encrypted ciphertext otherwise,
  // and we need plaintext values to set process.env.
  const url =
    `${VERCEL_API_BASE}/v9/projects/${VERCEL_PROJECT_ID}/env` +
    `?decrypt=true${teamParam}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      // 10s ceiling — Vercel API is usually sub-500ms; anything beyond that is
      // a sign of a regional outage and we'd rather fall back to .env quickly.
      signal: AbortSignal.timeout(10_000)
    });
  } catch (err) {
    return {
      ran: false,
      fromVercel: [],
      preservedLocal: [],
      emptyFromVercel: [],
      error: `Vercel API fetch failed: ${(err as Error).message}`
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "<no body>");
    return {
      ran: false,
      fromVercel: [],
      preservedLocal: [],
      emptyFromVercel: [],
      error: `Vercel API ${response.status}: ${body.slice(0, 200)}`
    };
  }

  const data = (await response.json()) as VercelEnvResponse;
  const envs = Array.isArray(data.envs) ? data.envs : [];

  const fromVercel: string[] = [];
  const preservedLocal: string[] = [];
  const emptyFromVercel: string[] = [];

  for (const entry of envs) {
    if (!entry.target.includes(target)) {
      continue;
    }
    if (!entry.value || entry.value === "") {
      emptyFromVercel.push(entry.key);
      continue;
    }

    const existing = process.env[entry.key];
    if (existing !== undefined && existing !== "") {
      // Local override wins — parent shell or .env explicitly set this.
      preservedLocal.push(entry.key);
      continue;
    }

    process.env[entry.key] = entry.value;
    fromVercel.push(entry.key);
  }

  return {
    ran: true,
    fromVercel,
    preservedLocal,
    emptyFromVercel,
    error: null
  };
}
