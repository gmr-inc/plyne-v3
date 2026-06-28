/**
 * Claude Max usage reader — SNAPSHOT source (the rate-limit-safe path).
 *
 * Why this exists: `/api/oauth/usage` is per-IP rate-limited. When the daemon
 * read it live on every cycle (auto-pause + pacing + the reporter), the endpoint
 * returned HTTP 429 continuously, the auto-pause reader returned null, and the
 * "don't burn the weekly Max" protection FAILED OPEN. With the gate effectively
 * off, Plyne could burn the whole weekly allowance to a dead cap.
 *
 * The fix decouples the readers:
 *   - the ~5-min Supabase quota REPORTER is the ONLY live caller of the endpoint
 *     (src/orchestrator/runner.ts → getMaxUsage → writeQuotaSnapshot), with 429
 *     backoff + last-good retention in max-usage.ts.
 *   - EVERYONE ELSE (the auto-pause hard caps + smart pacing) reads the latest
 *     persisted `claude_quota_snapshots` row from the plyne-app Supabase via this
 *     module. No endpoint call → no 429 → the gate always has a value.
 *
 * Staleness policy (PLYNE_V3_QUOTA_SNAPSHOT_MAX_AGE_MIN, default 20 min):
 *   - Fresh snapshot → use as-is (debug log).
 *   - Stale snapshot → log a clear WARN, but STILL return the last-good value so
 *     the hard caps keep applying. The WEEKLY cap moves slowly, so last-good is
 *     trustworthy. The SESSION cap moves fast, so a very stale snapshot is called
 *     out loudly (sessionStale=true) — we never fail-open silently.
 *   - No snapshot row at all (or Supabase down) → return null + warn. The caller
 *     (auto-pause) treats null as "proceed" only because the REACTIVE backstop
 *     (`isLimitHit`) remains the last line of defence.
 *
 * Posture: BEST-EFFORT. Never throws into the daemon hot path.
 */
import { getAppSupabase } from "../lib/supabase-app.js";
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { MaxUsage } from "./max-usage.js";

const QUOTA_TABLE = "claude_quota_snapshots";

/** A MaxUsage hydrated from a snapshot row, plus staleness diagnostics. */
export interface SnapshotUsage extends MaxUsage {
  /** Age of the snapshot in ms at read time (now - observed_at). */
  ageMs: number;
  /** True when ageMs exceeds the configured max-age threshold. */
  stale: boolean;
}

/** Coerce an unknown percent column to a clamped 0..100 number (0 on garbage). */
function toPct(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/** Normalize a timestamptz column → ISO string | null (drops unparseable). */
function toIso(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  return Number.isFinite(Date.parse(v)) ? v : null;
}

/**
 * Read the latest `claude_quota_snapshots` row and hydrate it into a MaxUsage.
 * Returns null (with a warn) when Supabase is unconfigured/down or the table is
 * empty — NEVER throws. `now` is injectable for deterministic tests.
 *
 * This is the data source the auto-pause gate consumes; it does NOT touch the
 * live `/api/oauth/usage` endpoint, so it can never 429.
 */
export async function getSnapshotUsage(now: number = Date.now()): Promise<SnapshotUsage | null> {
  const client = getAppSupabase();
  if (!client) {
    // The shared client already warned once about missing credentials.
    return null;
  }

  let row: Record<string, unknown> | null = null;
  try {
    const { data, error } = await client
      .from(QUOTA_TABLE)
      .select("session_used_pct, week_used_pct, week_resets_at, session_resets_at, observed_at")
      .order("observed_at", { ascending: false })
      .limit(1);
    if (error) {
      logger.warn({ err: error }, "quota-snapshot: latest snapshot query failed — auto-pause has no usage this cycle");
      return null;
    }
    row = (data && data.length > 0 ? (data[0] as Record<string, unknown>) : null) ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "quota-snapshot: latest snapshot read threw — auto-pause has no usage this cycle");
    return null;
  }

  if (!row) {
    logger.warn("quota-snapshot: no claude_quota_snapshots row yet — auto-pause has no usage this cycle");
    return null;
  }

  const observedAtIso = toIso(row["observed_at"]);
  const observedAtMs = observedAtIso ? Date.parse(observedAtIso) : NaN;
  const ageMs = Number.isFinite(observedAtMs) ? Math.max(0, now - observedAtMs) : Number.POSITIVE_INFINITY;

  const env = loadEnv();
  const maxAgeMs = env.PLYNE_V3_QUOTA_SNAPSHOT_MAX_AGE_MIN * 60_000;
  const stale = ageMs > maxAgeMs;

  const sessionPct = toPct(row["session_used_pct"]);
  const weeklyPct = toPct(row["week_used_pct"]);
  const weekResetsAt = toIso(row["week_resets_at"]);
  const sessionResetsAt = toIso(row["session_resets_at"]);

  const usage: SnapshotUsage = {
    sessionPct,
    weeklyPct,
    session: { utilization: sessionPct, resetsAt: sessionResetsAt },
    weekly: { utilization: weeklyPct, resetsAt: weekResetsAt },
    weekResetsAt,
    sessionResetsAt,
    fetchedAt: Number.isFinite(observedAtMs) ? observedAtMs : now,
    ageMs,
    stale
  };

  if (stale) {
    const ageMin = Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) : null;
    // Degrade LOUDLY, not silently. The weekly cap (slow) trusts last-good; the
    // session cap (fast) is flagged so the operator sees it's running on a stale
    // session signal — but we STILL apply the last-good caps (no fail-open).
    logger.warn(
      {
        ageMin,
        maxAgeMin: env.PLYNE_V3_QUOTA_SNAPSHOT_MAX_AGE_MIN,
        weeklyPct,
        sessionPct,
        sessionStale: true
      },
      "quota-snapshot: latest snapshot is STALE — applying last-good caps (weekly trusted, session signal aged). " +
        "Check the live quota reporter (429 backoff?) if this persists"
    );
  } else {
    logger.debug(
      { ageMs, weeklyPct, sessionPct },
      "quota-snapshot: read latest Max utilization from snapshot"
    );
  }

  return usage;
}
