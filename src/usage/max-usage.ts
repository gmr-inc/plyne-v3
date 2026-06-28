/**
 * Claude Max usage reader.
 *
 * Plyne v3 runs against a Claude Max OAuth session (subscriptionType "max").
 * Anthropic exposes the live Max utilization for that session at the OAuth
 * usage endpoint. Reading it lets the runner PAUSE dispatch *before* it burns
 * the weekly allowance to a dead cap (after which every `claude` invocation
 * 429s and the daemon just hammers a wall).
 *
 * Endpoint (verified via recon):
 *   GET https://api.anthropic.com/api/oauth/usage
 *   headers:
 *     Authorization: Bearer <oauth_access_token>
 *     anthropic-beta: oauth-2025-04-20
 *   → 200 JSON:
 *     {
 *       "five_hour":        {"utilization": <pct 0-100>, "resets_at": "<iso>"},
 *       "seven_day":        {"utilization": <pct>,       "resets_at": "<iso>"},
 *       "seven_day_opus":   {...} | null,
 *       "seven_day_sonnet": {...},
 *       "extra_usage":      {"is_enabled": false, ...}
 *     }
 *   `utilization` is a whole-number percent (e.g. 29.0 = 29%).
 *   `five_hour`  = the current 5h session window.
 *   `seven_day`  = the weekly window (the Max allowance we must protect).
 *
 * Token source: ~/.claude/.credentials.json → claudeAiOauth.accessToken. The
 * running daemon's normal `claude` invocations keep this fresh in-place, so we
 * just READ it each call. We deliberately do NOT do our own refresh-token
 * rotation — that would desync the CLI's credential file. If the token is
 * expired and the call 401s we log + return null; the next `claude` run
 * refreshes the file.
 *
 * Posture: BEST-EFFORT. Every failure path (missing file, parse error, 401,
 * network) returns `null` + a single warn and NEVER throws. A ~60s cache avoids
 * polling the endpoint on every task.
 *
 * SINGLE LIVE READER. As of the snapshot-decoupling fix, this module is the ONLY
 * thing that hits the live `/api/oauth/usage` endpoint, and it is driven solely
 * by the ~5-min Supabase quota reporter (src/orchestrator/runner.ts →
 * writeQuotaSnapshot). Everything that makes auto-pause/pacing decisions reads
 * the persisted snapshot row instead (src/usage/quota-snapshot.ts). One live
 * call per ~5 min is far under the per-IP rate limit.
 *
 * 429 BACKOFF + LAST-GOOD. The endpoint is per-IP rate-limited. When it returns
 * HTTP 429 we DO NOT clear the cache — we keep returning the previous good
 * reading (last-good retention) and apply an exponential backoff so we don't
 * keep poking a closed window. The backoff resets the moment a real 200 lands,
 * so the snapshot refreshes as soon as the per-IP window clears.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "../config/logger.js";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const DEFAULT_CREDENTIALS_PATH = "~/.claude/.credentials.json";
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

// 429 backoff: when the per-IP rate limit trips, wait at least this long before
// the next live attempt, doubling on each consecutive 429 up to the ceiling.
// At the reporter's ~5-min cadence a single 429 is already absorbed by the next
// tick; the backoff just guarantees we never tighten that cadence under load.
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

/** One usage window (5h or 7d) parsed from the endpoint. */
export interface UsageWindow {
  /** Whole-number percent 0-100. */
  utilization: number;
  /** ISO-8601 timestamp the window resets at, or null when absent. */
  resetsAt: string | null;
}

export interface MaxUsage {
  /** five_hour.utilization — the current session window %. */
  sessionPct: number;
  /** seven_day.utilization — the weekly Max allowance %. */
  weeklyPct: number;
  /** five_hour window (pct + resets_at). */
  session: UsageWindow;
  /** seven_day window (pct + resets_at). */
  weekly: UsageWindow;
  /** seven_day.resets_at — ISO ts the weekly window resets at (null if absent). */
  weekResetsAt: string | null;
  /** five_hour.resets_at — ISO ts the 5h session window resets at (null if absent). */
  sessionResetsAt: string | null;
  /** Wall-clock ms when this reading was taken. */
  fetchedAt: number;
}

/** Expand a leading `~` to the user's home dir. */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Resolve the credentials path: env override → default ~/.claude. */
export function resolveCredentialsPath(): string {
  // Read straight from process.env (not the cached loadEnv snapshot) so the
  // path can be repointed at runtime/tests without a re-import. loadEnv() is
  // still the source of truth for typed knobs (thresholds); this one field is
  // a plain filesystem path with a safe default.
  const override = process.env["CLAUDE_CREDENTIALS_PATH"];
  return expandHome(override && override.length > 0 ? override : DEFAULT_CREDENTIALS_PATH);
}

/**
 * Read claudeAiOauth.accessToken from the credentials file. Returns null (with
 * a warn) when the file is missing, unreadable, malformed, or has no token.
 */
export function readOAuthAccessToken(filePath = resolveCredentialsPath()): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    logger.warn({ err, filePath }, "max-usage: credentials file unreadable — skipping usage read");
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = parsed?.claudeAiOauth?.accessToken;
    if (typeof token !== "string" || token.length === 0) {
      logger.warn({ filePath }, "max-usage: claudeAiOauth.accessToken missing/empty — skipping usage read");
      return null;
    }
    return token;
  } catch (err) {
    logger.warn({ err, filePath }, "max-usage: credentials file is not valid JSON — skipping usage read");
    return null;
  }
}

/** Coerce an unknown utilization field to a clamped whole-number percent. */
function toPct(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function parseWindow(w: unknown): UsageWindow {
  const obj = (w ?? {}) as Record<string, unknown>;
  const resetsAtRaw = obj["resets_at"];
  return {
    utilization: toPct(obj["utilization"]),
    resetsAt: typeof resetsAtRaw === "string" && resetsAtRaw.length > 0 ? resetsAtRaw : null
  };
}

/**
 * Parse the raw usage JSON into a MaxUsage. Tolerant of missing windows
 * (utilization defaults to 0, resetsAt to null) so a partial response never
 * throws. Exported for unit tests.
 */
export function parseUsageResponse(body: unknown, fetchedAt = Date.now()): MaxUsage {
  const obj = (body ?? {}) as Record<string, unknown>;
  const session = parseWindow(obj["five_hour"]);
  const weekly = parseWindow(obj["seven_day"]);
  return {
    sessionPct: session.utilization,
    weeklyPct: weekly.utilization,
    session,
    weekly,
    weekResetsAt: weekly.resetsAt,
    sessionResetsAt: session.resetsAt,
    fetchedAt
  };
}

let _cache: MaxUsage | null = null;
let _cacheAt = 0;
// 429 backoff state: wall-clock ms before which we must not re-attempt the live
// call, and the current backoff window (doubles per consecutive 429, resets on
// a 200). While backed off we keep returning `_cache` (last-good).
let _backoffUntil = 0;
let _backoffMs = 0;

/** Allow tests to swap in a fetch stub without hitting the network. */
type FetchFn = typeof fetch;
let _fetchOverride: FetchFn | undefined;

/**
 * Read the live Max usage. Cached ~60s. Returns the last-good reading (or null)
 * on ANY error (missing token, 401, network, non-200, parse) after logging a
 * single warn — never throws. `force: true` bypasses the freshness cache (used
 * by the quota reporter so the surfaced snapshot is fresh on its own cadence)
 * but STILL honours the 429 backoff window, since that's about protecting the
 * per-IP rate limit, not about cache freshness.
 *
 * This is the ONLY live caller of `/api/oauth/usage`. The auto-pause/pacing
 * path reads the persisted snapshot instead (src/usage/quota-snapshot.ts).
 */
export async function getMaxUsage(opts: { force?: boolean } = {}): Promise<MaxUsage | null> {
  const now = Date.now();
  if (!opts.force && _cache && now - _cacheAt < CACHE_TTL_MS) {
    return _cache;
  }

  // 429 backoff: while the per-IP window is closed, don't re-attempt — return
  // the previous good reading so the snapshot reporter keeps writing last-good
  // instead of nulling the dashboard / spamming the endpoint.
  if (now < _backoffUntil) {
    logger.debug(
      { backoffUntil: new Date(_backoffUntil).toISOString(), haveLastGood: _cache !== null },
      "max-usage: in 429 backoff — returning last-good reading without hitting the endpoint"
    );
    return _cache;
  }

  const token = readOAuthAccessToken();
  if (!token) return _cache;

  const fetchFn: FetchFn = _fetchOverride ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchFn(USAGE_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA_HEADER
      },
      signal: controller.signal
    });
    if (res.status === 429) {
      // Per-IP rate limit. Do NOT clear the cache — keep last-good and back off
      // exponentially so we eventually refresh once the window clears.
      _backoffMs = _backoffMs === 0 ? BACKOFF_BASE_MS : Math.min(_backoffMs * 2, BACKOFF_MAX_MS);
      _backoffUntil = Date.now() + _backoffMs;
      logger.warn(
        { backoffMs: _backoffMs, backoffUntil: new Date(_backoffUntil).toISOString(), haveLastGood: _cache !== null },
        "max-usage: usage endpoint 429 (rate limited) — keeping last-good, backing off"
      );
      return _cache;
    }
    if (!res.ok) {
      // 401 = token expired in-place (the CLI hasn't refreshed yet). Log and
      // skip; the next `claude` run refreshes the credentials file for us. We
      // never attempt our own refresh-token rotation here. Keep last-good so a
      // transient non-200 doesn't blank the snapshot.
      logger.warn({ status: res.status }, "max-usage: usage endpoint returned non-200 — keeping last-good this cycle");
      return _cache;
    }
    const json = (await res.json()) as unknown;
    const usage = parseUsageResponse(json, Date.now());
    _cache = usage;
    _cacheAt = usage.fetchedAt;
    // A real 200 clears any backoff so the next refresh isn't delayed.
    _backoffMs = 0;
    _backoffUntil = 0;
    logger.debug(
      { sessionPct: usage.sessionPct, weeklyPct: usage.weeklyPct },
      "max-usage: read live Max utilization"
    );
    return usage;
  } catch (err) {
    logger.warn({ err }, "max-usage: usage read failed (network/abort/parse) — keeping last-good");
    return _cache;
  } finally {
    clearTimeout(timer);
  }
}

/** Test helpers — reset cache + inject a fetch stub. Not a runtime surface. */
export const __test = {
  reset(): void {
    _cache = null;
    _cacheAt = 0;
    _backoffUntil = 0;
    _backoffMs = 0;
    _fetchOverride = undefined;
  },
  injectFetch(fn: FetchFn | undefined): void {
    _fetchOverride = fn;
  },
  peekCache(): MaxUsage | null {
    return _cache;
  },
  peekBackoff(): { until: number; ms: number } {
    return { until: _backoffUntil, ms: _backoffMs };
  }
};
