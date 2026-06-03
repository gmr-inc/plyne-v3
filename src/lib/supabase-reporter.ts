/**
 * Plyne v3 → plyne-app Supabase LIVE reporter.
 *
 * Problem this fixes: v3 historically wrote task lifecycle ONLY to Notion.
 * The plyne.dev FE reads the plyne-app Supabase and so never saw daemon
 * progress ("things go out but nothing comes back in"). Supabase realtime is
 * already enabled on the relevant tables, so as soon as v3 writes here, the FE
 * pipeline / tabs / PR view / dashboard dot update live.
 *
 * Three reporters, ALL best-effort (never throw into the daemon hot path):
 *   1. mirrorTaskStatus()  — UPDATE plyne-app `tasks` by notion_page_id on
 *      every status change (the main fix). Live.
 *   2. startHeartbeat()    — every ~10s UPSERT `daemon_heartbeat` (drives the
 *      dashboard online/offline dot + in-flight count).
 *   3. Quota — investigated below; v3 has NO programmatic Max-plan quota
 *      signal, so we deliberately DO NOT write fake `claude_quota_snapshots`.
 *
 * All writes go through the shared client in supabase-app.ts. When the
 * PLYNE_APP_SUPABASE_* env vars are absent the client is null and every
 * function no-ops with at most a single warn.
 */
import { getAppSupabase } from "./supabase-app.js";
import { logger } from "../config/logger.js";

const TASKS_TABLE = "tasks";
const HEARTBEAT_TABLE = "daemon_heartbeat";
const QUOTA_TABLE = "claude_quota_snapshots";
const DAEMON_ID = "plyne-v3";
const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Mirror a task status change into the plyne-app `tasks` table.
 *
 * Matched by `notion_page_id = pageId` (the FE creates the row with this set,
 * so this is an UPDATE — never an insert). Sets `status`, `pr_url` (only when
 * provided), and `last_edited_at = now()`. If no row matches we skip quietly
 * (a v3-internal task the FE hasn't materialized is not an error here).
 *
 * Best-effort: returns void, swallows + logs all failures. Callers in the
 * orchestrator hot path must never have to try/catch this.
 */
export async function mirrorTaskStatus(
  pageId: string,
  status: string,
  prUrl?: string
): Promise<void> {
  const client = getAppSupabase();
  if (!client) return;

  const patch: Record<string, unknown> = {
    status,
    last_edited_at: new Date().toISOString()
  };
  if (prUrl) patch["pr_url"] = prUrl;

  try {
    const { data, error } = await client
      .from(TASKS_TABLE)
      .update(patch)
      .eq("notion_page_id", pageId)
      .select("id");
    if (error) {
      logger.warn({ err: error, pageId, status }, "reporter: tasks mirror update failed");
      return;
    }
    if (!data || data.length === 0) {
      logger.debug({ pageId, status }, "reporter: no plyne-app tasks row for notion_page_id — skipped");
      return;
    }
    logger.info({ pageId, status, prUrl: prUrl ?? null, matched: data.length }, "reporter: tasks mirror written");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message, pageId, status }, "reporter: tasks mirror threw");
  }
}

/**
 * Upsert one heartbeat row. PK is `daemon`; `mode` defaults to 'running'.
 * `inFlight` is the count of tasks the runner currently has claiming/executing.
 */
async function writeHeartbeat(inFlight: number, mode: string): Promise<void> {
  const client = getAppSupabase();
  if (!client) return;
  try {
    const { error } = await client.from(HEARTBEAT_TABLE).upsert(
      {
        daemon: DAEMON_ID,
        last_seen: new Date().toISOString(),
        mode,
        in_flight: inFlight
      },
      { onConflict: "daemon" }
    );
    if (error) {
      logger.warn({ err: error }, "reporter: heartbeat upsert failed");
      return;
    }
    logger.debug({ inFlight, mode }, "reporter: heartbeat written");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "reporter: heartbeat threw");
  }
}

let _heartbeatTimer: NodeJS.Timeout | undefined;

/**
 * Start the ~10s heartbeat loop. `getInFlight` is read each tick so the count
 * reflects the runner's live in-flight set. No-ops (with the shared warn) when
 * the plyne-app credentials are absent. Idempotent — a second call clears the
 * previous timer first.
 *
 * Returns a stop function; also call stopHeartbeat() from the signal handlers.
 */
export function startHeartbeat(getInFlight: () => number): () => void {
  stopHeartbeat();
  const client = getAppSupabase();
  if (!client) {
    // No credentials → nothing to do. The shared client already warned once.
    return () => {};
  }
  logger.info({ intervalMs: HEARTBEAT_INTERVAL_MS }, "reporter: starting daemon heartbeat");
  // Fire one immediately so the dashboard dot flips online without waiting a
  // full interval after (re)start.
  void writeHeartbeat(safeInFlight(getInFlight), "running");
  _heartbeatTimer = setInterval(() => {
    void writeHeartbeat(safeInFlight(getInFlight), "running");
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive solely for the heartbeat.
  _heartbeatTimer.unref?.();
  return stopHeartbeat;
}

/** Clear the heartbeat interval (call on SIGTERM/SIGINT). Idempotent. */
export function stopHeartbeat(): void {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = undefined;
  }
}

/**
 * Insert one Claude Max quota snapshot so the FE "Plyne Max quota" card can show
 * real numbers (the table is otherwise empty). Best-effort — no-ops when the
 * shared client is null, swallows + logs every failure. Matches the FE contract:
 * `{ session_used_pct, week_used_pct, observed_at }`.
 */
export async function writeQuotaSnapshot(sessionPct: number, weeklyPct: number): Promise<void> {
  const client = getAppSupabase();
  if (!client) return;
  // Guard against a malformed reading slipping bad rows onto the dashboard.
  const session = Number.isFinite(sessionPct) ? Math.max(0, Math.min(100, sessionPct)) : 0;
  const week = Number.isFinite(weeklyPct) ? Math.max(0, Math.min(100, weeklyPct)) : 0;
  try {
    const { error } = await client.from(QUOTA_TABLE).insert({
      session_used_pct: session,
      week_used_pct: week,
      observed_at: new Date().toISOString()
    });
    if (error) {
      logger.warn({ err: error, session, week }, "reporter: quota snapshot insert failed");
      return;
    }
    logger.debug({ session, week }, "reporter: quota snapshot written");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, "reporter: quota snapshot threw");
  }
}

function safeInFlight(getInFlight: () => number): number {
  try {
    const n = getInFlight();
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}
