/**
 * Plyne v3 notifications writer.
 *
 * Writes "human attention required" events into the plyne-app Supabase
 * `public.notifications` table so the UI bell can surface them.
 *
 * Contract (mirrored by plyne-app migration 20260602220000_plyne_notifications):
 *   - kind ∈ task_escalated | pr_opened | task_failed | daemon_alert
 *   - severity ∈ info | warn | error
 *   - owner_user_id null = broadcast to all admins
 *
 * Idempotency: we skip writes when (task_id, kind) was already emitted in the
 * last DEDUPE_TTL_MS. This guards against the runner double-firing on the
 * same task (e.g. retry loop). Daemon restart resets the cache — the worst
 * case is one duplicate row per restart, which a human reader can dismiss.
 *
 * Failure mode: ALL write failures are swallowed + logged. The runner must
 * never crash because the notification sink is down. (Same posture as the
 * Notion comment path in runner.ts.)
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";

export type NotificationKind = "task_escalated" | "pr_opened" | "task_failed" | "daemon_alert";
export type NotificationSeverity = "info" | "warn" | "error";

export interface NotifyInput {
  kind: NotificationKind;
  body: string;
  severity?: NotificationSeverity;
  /** Notion page id (or any stable task identifier). */
  task_id?: string | null;
  /** Denormalized title for UI display. */
  task_name?: string | null;
  /** null/undefined = broadcast to all admins. */
  owner_user_id?: string | null;
  /** Free-form metadata persisted as JSONB (pr_url, external_id, etc.). */
  metadata?: Record<string, unknown>;
}

const DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 minutes per the spec

/**
 * In-process dedupe: key = `<task_id>:<kind>`. Pure side-effect on this
 * process; resets on restart. Acceptable because notification dupes are
 * cheap (human dismisses) and we'd rather miss-suppress than miss-emit.
 */
class NotifyDedupe {
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(opts: { now?: () => number; ttlMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? DEDUPE_TTL_MS;
  }

  shouldEmit(taskId: string | null | undefined, kind: NotificationKind): boolean {
    // Without a task_id we cannot dedupe — let the event through. (Broadcast
    // daemon_alerts on auth circuit-breaker etc. usually carry no task_id.)
    if (!taskId) return true;
    const now = this.now();
    this.prune(now);
    const key = `${taskId}:${kind}`;
    const prev = this.seen.get(key);
    if (prev !== undefined && now - prev <= this.ttlMs) return false;
    this.seen.set(key, now);
    return true;
  }

  size(): number {
    return this.seen.size;
  }

  private prune(now: number): void {
    for (const [k, ts] of this.seen) {
      if (now - ts > this.ttlMs) this.seen.delete(k);
    }
  }
}

let _client: SupabaseClient | null = null;
let _disabled = false;
const _dedupe = new NotifyDedupe();

function getClient(): SupabaseClient | null {
  if (_disabled) return null;
  if (_client) return _client;
  const env = loadEnv();
  const url = env.PLYNE_APP_SUPABASE_URL;
  const key = env.PLYNE_APP_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    if (!_disabled) {
      logger.info(
        "notify: PLYNE_APP_SUPABASE_URL / PLYNE_APP_SUPABASE_SERVICE_ROLE_KEY not set — notifications writer disabled"
      );
      _disabled = true;
    }
    return null;
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return _client;
}

export interface NotifyResult {
  ok: boolean;
  skipped?: "disabled" | "deduped";
  error?: string;
}

/**
 * Emit one notification. Returns a status object instead of throwing so
 * callers can sit in hot orchestration paths without try/catch boilerplate.
 */
export async function notify(input: NotifyInput): Promise<NotifyResult> {
  if (!_dedupe.shouldEmit(input.task_id ?? null, input.kind)) {
    logger.debug(
      { taskId: input.task_id, kind: input.kind },
      "notify: deduped (same task_id + kind within 5 min)"
    );
    return { ok: false, skipped: "deduped" };
  }
  const client = getClient();
  if (!client) return { ok: false, skipped: "disabled" };

  const row = {
    kind: input.kind,
    body: input.body,
    severity: input.severity ?? "info",
    task_id: input.task_id ?? null,
    task_name: input.task_name ?? null,
    owner_user_id: input.owner_user_id ?? null,
    metadata: input.metadata ?? {}
  };

  try {
    const { error } = await client.from("notifications").insert(row);
    if (error) {
      logger.warn({ err: error, row: { kind: row.kind, taskId: row.task_id } }, "notify: insert failed");
      return { ok: false, error: error.message };
    }
    logger.info(
      { kind: row.kind, taskId: row.task_id, severity: row.severity },
      "notify: written"
    );
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message, kind: row.kind }, "notify: insert threw");
    return { ok: false, error: message };
  }
}

/**
 * Test helpers — exported so __tests__ can reset state between cases without
 * touching module-private vars. Not part of the public runtime surface.
 */
export const __test = {
  reset(): void {
    _client = null;
    _disabled = false;
    (_dedupe as unknown as { seen: Map<string, number> }).seen.clear();
  },
  injectClient(c: SupabaseClient | null): void {
    _client = c;
    _disabled = c === null;
  },
  dedupeSize(): number {
    return _dedupe.size();
  },
  NotifyDedupe
};
