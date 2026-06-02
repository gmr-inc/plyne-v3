/**
 * notifications-writer tests — run under `node --test` (no jest/vitest).
 *
 * Covers:
 *   - in-process dedupe (same task_id + kind within TTL)
 *   - different kinds for same task → both emit
 *   - null task_id always emits (broadcast alerts can't dedupe)
 *   - disabled-when-env-missing graceful no-op
 *   - insert error swallowed (no throw)
 *   - happy path returns ok: true
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { notify, __test, type NotificationKind } from "../notifications-writer.js";

// Minimal stub matching the `.from(...).insert(...)` surface we hit.
function makeStubClient(opts: { fail?: boolean; throwOn?: boolean } = {}) {
  const inserts: unknown[] = [];
  const client = {
    from(_table: string) {
      return {
        async insert(row: unknown) {
          inserts.push(row);
          if (opts.throwOn) throw new Error("simulated network blowup");
          if (opts.fail) return { error: { message: "rls denied" } };
          return { error: null };
        }
      };
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, inserts };
}

describe("notifications-writer / dedupe (unit)", () => {
  it("emits the first time for a given (task_id, kind)", () => {
    const d = new __test.NotifyDedupe();
    assert.equal(d.shouldEmit("task-1", "pr_opened"), true);
  });

  it("dedupes the second time within the TTL window", () => {
    const d = new __test.NotifyDedupe();
    assert.equal(d.shouldEmit("task-1", "pr_opened"), true);
    assert.equal(d.shouldEmit("task-1", "pr_opened"), false);
  });

  it("does NOT dedupe across different kinds for the same task", () => {
    const d = new __test.NotifyDedupe();
    assert.equal(d.shouldEmit("task-1", "pr_opened"), true);
    assert.equal(d.shouldEmit("task-1", "task_failed"), true);
  });

  it("re-emits after TTL expires", () => {
    let now = 1_000_000;
    const d = new __test.NotifyDedupe({ ttlMs: 100, now: () => now });
    assert.equal(d.shouldEmit("t", "task_failed" as NotificationKind), true);
    now += 50;
    assert.equal(d.shouldEmit("t", "task_failed" as NotificationKind), false);
    now += 100;
    assert.equal(d.shouldEmit("t", "task_failed" as NotificationKind), true);
  });

  it("never dedupes when task_id is null/undefined", () => {
    const d = new __test.NotifyDedupe();
    assert.equal(d.shouldEmit(null, "daemon_alert"), true);
    assert.equal(d.shouldEmit(null, "daemon_alert"), true);
    assert.equal(d.shouldEmit(undefined, "daemon_alert"), true);
  });
});

describe("notifications-writer / notify (integration with stub client)", () => {
  beforeEach(() => {
    __test.reset();
  });

  it("no-ops with skipped='disabled' when no client is injected and env is missing", async () => {
    // env is missing PLYNE_APP_SUPABASE_URL in test env, so internal lazy-init
    // bails out. After reset() we have no injected client either.
    const out = await notify({ kind: "pr_opened", body: "x" });
    assert.equal(out.ok, false);
    assert.equal(out.skipped, "disabled");
  });

  it("writes the expected row on happy path", async () => {
    const { client, inserts } = makeStubClient();
    __test.injectClient(client);
    const out = await notify({
      kind: "pr_opened",
      body: "PR opened for V3-TEST-NOTIFY-001",
      severity: "info",
      task_id: "task-uuid-1",
      task_name: "V3-TEST-NOTIFY-001",
      metadata: { pr_url: "https://github.com/gmr-inc/x/pull/1" }
    });
    assert.equal(out.ok, true);
    assert.equal(inserts.length, 1);
    const row = inserts[0] as Record<string, unknown>;
    assert.equal(row.kind, "pr_opened");
    assert.equal(row.severity, "info");
    assert.equal(row.task_id, "task-uuid-1");
    assert.equal(row.task_name, "V3-TEST-NOTIFY-001");
    assert.equal(row.owner_user_id, null);
    assert.deepEqual(row.metadata, { pr_url: "https://github.com/gmr-inc/x/pull/1" });
  });

  it("dedupes a second emit for the same (task_id, kind) within TTL", async () => {
    const { client, inserts } = makeStubClient();
    __test.injectClient(client);
    const first = await notify({ kind: "task_failed", body: "x", task_id: "task-uuid-2" });
    const second = await notify({ kind: "task_failed", body: "x again", task_id: "task-uuid-2" });
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.skipped, "deduped");
    assert.equal(inserts.length, 1);
  });

  it("allows different kinds for the same task_id back-to-back", async () => {
    const { client, inserts } = makeStubClient();
    __test.injectClient(client);
    await notify({ kind: "pr_opened", body: "a", task_id: "task-uuid-3" });
    await notify({ kind: "task_failed", body: "b", task_id: "task-uuid-3" });
    assert.equal(inserts.length, 2);
  });

  it("returns ok:false (no throw) when insert returns an error", async () => {
    const { client } = makeStubClient({ fail: true });
    __test.injectClient(client);
    const out = await notify({ kind: "task_failed", body: "x", task_id: "task-uuid-4" });
    assert.equal(out.ok, false);
    assert.equal(out.error, "rls denied");
  });

  it("returns ok:false (no throw) when insert throws", async () => {
    const { client } = makeStubClient({ throwOn: true });
    __test.injectClient(client);
    const out = await notify({ kind: "daemon_alert", body: "x", task_id: "task-uuid-5" });
    assert.equal(out.ok, false);
    assert.equal(typeof out.error, "string");
  });

  it("defaults severity to 'info' when not specified", async () => {
    const { client, inserts } = makeStubClient();
    __test.injectClient(client);
    await notify({ kind: "pr_opened", body: "x", task_id: "task-uuid-6" });
    const row = inserts[0] as Record<string, unknown>;
    assert.equal(row.severity, "info");
  });
});
