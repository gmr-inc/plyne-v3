/**
 * supabase-reporter tests — run under `node --test` (no jest/vitest).
 *
 * Covers the best-effort contract that keeps the reporter from ever crashing
 * or blocking the daemon:
 *   - mirrorTaskStatus no-ops when the shared client is null (env unset)
 *   - mirrorTaskStatus issues an UPDATE by notion_page_id with status +
 *     last_edited_at, and pr_url only when provided
 *   - mirrorTaskStatus swallows update errors and thrown errors (no reject)
 *   - startHeartbeat no-ops (returns without scheduling) when client is null
 *   - heartbeat upsert targets daemon_heartbeat on conflict 'daemon'
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mirrorTaskStatus, startHeartbeat, stopHeartbeat, writeQuotaSnapshot } from "../supabase-reporter.js";
import { __test as appTest } from "../supabase-app.js";

interface Captured {
  table: string;
  op: "update" | "upsert" | "insert";
  payload: unknown;
  eq?: { col: string; val: unknown };
  onConflict?: string;
}

function makeStubClient(opts: { updateError?: boolean; throwOn?: boolean; matched?: number } = {}) {
  const calls: Captured[] = [];
  const client = {
    from(table: string) {
      return {
        update(payload: unknown) {
          const cap: Captured = { table, op: "update", payload };
          calls.push(cap);
          return {
            eq(col: string, val: unknown) {
              cap.eq = { col, val };
              return {
                async select(_cols: string) {
                  if (opts.throwOn) throw new Error("boom");
                  if (opts.updateError) return { data: null, error: { message: "rls denied" } };
                  const n = opts.matched ?? 1;
                  return { data: Array.from({ length: n }, (_v, i) => ({ id: `row-${i}` })), error: null };
                }
              };
            }
          };
        },
        async upsert(payload: unknown, options: { onConflict?: string }) {
          const cap: Captured = { table, op: "upsert", payload };
          if (options?.onConflict !== undefined) cap.onConflict = options.onConflict;
          calls.push(cap);
          if (opts.throwOn) throw new Error("boom");
          return { error: null };
        },
        async insert(payload: unknown) {
          const cap: Captured = { table, op: "insert", payload };
          calls.push(cap);
          if (opts.throwOn) throw new Error("boom");
          if (opts.updateError) return { error: { message: "rls denied" } };
          return { error: null };
        }
      };
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls };
}

describe("supabase-reporter / mirrorTaskStatus", () => {
  beforeEach(() => appTest.reset());
  afterEach(() => appTest.reset());

  it("no-ops when the shared client is null (env unset)", async () => {
    appTest.injectClient(null);
    await assert.doesNotReject(mirrorTaskStatus("page-1", "executing"));
  });

  it("issues UPDATE by notion_page_id with status + last_edited_at, no pr_url", async () => {
    const { client, calls } = makeStubClient();
    appTest.injectClient(client);
    await mirrorTaskStatus("page-1", "executing");
    assert.equal(calls.length, 1);
    const c = calls[0]!;
    assert.equal(c.table, "tasks");
    assert.equal(c.op, "update");
    assert.deepEqual(c.eq, { col: "notion_page_id", val: "page-1" });
    const payload = c.payload as Record<string, unknown>;
    assert.equal(payload["status"], "executing");
    assert.ok(typeof payload["last_edited_at"] === "string");
    assert.ok(!("pr_url" in payload));
  });

  it("includes pr_url when provided", async () => {
    const { client, calls } = makeStubClient();
    appTest.injectClient(client);
    await mirrorTaskStatus("page-2", "pr-open", "https://github.com/x/y/pull/1");
    const payload = calls[0]!.payload as Record<string, unknown>;
    assert.equal(payload["pr_url"], "https://github.com/x/y/pull/1");
  });

  it("swallows an update error (no reject)", async () => {
    const { client } = makeStubClient({ updateError: true });
    appTest.injectClient(client);
    await assert.doesNotReject(mirrorTaskStatus("page-3", "done"));
  });

  it("swallows a thrown error (no reject)", async () => {
    const { client } = makeStubClient({ throwOn: true });
    appTest.injectClient(client);
    await assert.doesNotReject(mirrorTaskStatus("page-4", "done"));
  });

  it("skips quietly when no row matches notion_page_id", async () => {
    const { client } = makeStubClient({ matched: 0 });
    appTest.injectClient(client);
    await assert.doesNotReject(mirrorTaskStatus("page-missing", "claiming"));
  });
});

describe("supabase-reporter / writeQuotaSnapshot", () => {
  beforeEach(() => appTest.reset());
  afterEach(() => appTest.reset());

  it("no-ops when the shared client is null (env unset)", async () => {
    appTest.injectClient(null);
    await assert.doesNotReject(writeQuotaSnapshot(29, 91));
  });

  it("inserts session_used_pct + week_used_pct + observed_at into claude_quota_snapshots", async () => {
    const { client, calls } = makeStubClient();
    appTest.injectClient(client);
    await writeQuotaSnapshot(29, 91);
    assert.equal(calls.length, 1);
    const c = calls[0]!;
    assert.equal(c.table, "claude_quota_snapshots");
    assert.equal(c.op, "insert");
    const payload = c.payload as Record<string, unknown>;
    assert.equal(payload["session_used_pct"], 29);
    assert.equal(payload["week_used_pct"], 91);
    assert.ok(typeof payload["observed_at"] === "string");
  });

  it("clamps out-of-range / non-finite percents", async () => {
    const { client, calls } = makeStubClient();
    appTest.injectClient(client);
    await writeQuotaSnapshot(NaN, 150);
    const payload = calls[0]!.payload as Record<string, unknown>;
    assert.equal(payload["session_used_pct"], 0);
    assert.equal(payload["week_used_pct"], 100);
  });

  it("swallows an insert error (no reject)", async () => {
    const { client } = makeStubClient({ updateError: true });
    appTest.injectClient(client);
    await assert.doesNotReject(writeQuotaSnapshot(1, 2));
  });

  it("swallows a thrown error (no reject)", async () => {
    const { client } = makeStubClient({ throwOn: true });
    appTest.injectClient(client);
    await assert.doesNotReject(writeQuotaSnapshot(1, 2));
  });

  it("includes week_resets_at + session_resets_at when supplied", async () => {
    const { client, calls } = makeStubClient();
    appTest.injectClient(client);
    await writeQuotaSnapshot(29, 91, {
      weekResetsAt: "2026-06-08T00:00:00Z",
      sessionResetsAt: "2026-06-03T05:00:00Z"
    });
    assert.equal(calls.length, 1);
    const payload = calls[0]!.payload as Record<string, unknown>;
    assert.equal(payload["week_resets_at"], "2026-06-08T00:00:00Z");
    assert.equal(payload["session_resets_at"], "2026-06-03T05:00:00Z");
  });

  it("omits reset columns entirely when no (valid) resets supplied", async () => {
    const { client, calls } = makeStubClient();
    appTest.injectClient(client);
    await writeQuotaSnapshot(29, 91, { weekResetsAt: "not-a-date", sessionResetsAt: null });
    const payload = calls[0]!.payload as Record<string, unknown>;
    assert.ok(!("week_resets_at" in payload));
    assert.ok(!("session_resets_at" in payload));
  });

  it("falls back to a reset-less insert when the columns don't exist (PGRST204)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let attempt = 0;
    const client = {
      from(_table: string) {
        return {
          async insert(payload: Record<string, unknown>) {
            attempt += 1;
            calls.push(payload);
            // First attempt carries reset columns → simulate the migration gap.
            if ("week_resets_at" in payload || "session_resets_at" in payload) {
              return { error: { code: "PGRST204", message: "Could not find the 'week_resets_at' column" } };
            }
            return { error: null };
          }
        };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    appTest.injectClient(client);
    await assert.doesNotReject(
      writeQuotaSnapshot(29, 91, { weekResetsAt: "2026-06-08T00:00:00Z", sessionResetsAt: null })
    );
    assert.equal(attempt, 2);
    // Retry payload must NOT contain the reset columns.
    const retry = calls[1]!;
    assert.ok(!("week_resets_at" in retry));
    assert.ok(!("session_resets_at" in retry));
    assert.equal(retry["session_used_pct"], 29);
    assert.equal(retry["week_used_pct"], 91);
  });
});

describe("supabase-reporter / startHeartbeat", () => {
  beforeEach(() => appTest.reset());
  afterEach(() => {
    stopHeartbeat();
    appTest.reset();
  });

  it("no-ops (no scheduling) when the shared client is null", () => {
    appTest.injectClient(null);
    const stop = startHeartbeat(() => 0);
    assert.equal(typeof stop, "function");
    stop();
  });

  it("upserts daemon_heartbeat on conflict 'daemon' with in_flight count", async () => {
    const { client, calls } = makeStubClient();
    appTest.injectClient(client);
    startHeartbeat(() => 2);
    // the immediate fire is async; give the microtask queue a tick
    await new Promise((r) => setTimeout(r, 5));
    stopHeartbeat();
    assert.ok(calls.length >= 1);
    const c = calls[0]!;
    assert.equal(c.table, "daemon_heartbeat");
    assert.equal(c.op, "upsert");
    assert.equal(c.onConflict, "daemon");
    const payload = c.payload as Record<string, unknown>;
    assert.equal(payload["daemon"], "plyne-v3");
    assert.equal(payload["mode"], "running");
    assert.equal(payload["in_flight"], 2);
    assert.ok(typeof payload["last_seen"] === "string");
  });
});
