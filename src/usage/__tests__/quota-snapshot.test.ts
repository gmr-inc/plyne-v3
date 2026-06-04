/**
 * quota-snapshot tests — run under `node --test` (no jest/vitest).
 *
 * Covers the rate-limit-safe data source the auto-pause/pacing gate consumes:
 *   - reads the latest claude_quota_snapshots row (select+order+limit) and
 *     hydrates it into a MaxUsage WITHOUT touching /api/oauth/usage
 *   - fresh snapshot → stale=false; old snapshot → stale=true (loud WARN path)
 *   - missing client / empty table / query error / thrown → null (no throw)
 *   - decidePause consumes the snapshot usage exactly like a live reading would
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getSnapshotUsage } from "../quota-snapshot.js";
import { decidePause } from "../auto-pause.js";
import { __test as appTest } from "../../lib/supabase-app.js";

/**
 * Minimal stub of the PostgREST chain used by getSnapshotUsage:
 *   from(table).select(cols).order(col,opts).limit(n) → { data, error }
 */
function makeSnapshotClient(opts: {
  row?: Record<string, unknown> | null;
  error?: unknown;
  throwOn?: boolean;
}) {
  const captured: { table?: string; cols?: string; orderCol?: string; ascending?: unknown; limit?: number } = {};
  const client = {
    from(table: string) {
      captured.table = table;
      return {
        select(cols: string) {
          captured.cols = cols;
          return {
            order(col: string, o: { ascending?: boolean }) {
              captured.orderCol = col;
              captured.ascending = o?.ascending;
              return {
                async limit(n: number) {
                  captured.limit = n;
                  if (opts.throwOn) throw new Error("boom");
                  if (opts.error) return { data: null, error: opts.error };
                  const data = opts.row ? [opts.row] : [];
                  return { data, error: null };
                }
              };
            }
          };
        }
      };
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, captured };
}

const NOW = Date.parse("2026-06-04T12:00:00Z");

function freshRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_used_pct: 29,
    week_used_pct: 91,
    week_resets_at: "2026-06-09T00:00:00Z",
    session_resets_at: "2026-06-04T17:00:00Z",
    observed_at: new Date(NOW - 2 * 60_000).toISOString(), // 2 min old
    ...over
  };
}

describe("quota-snapshot / getSnapshotUsage", () => {
  beforeEach(() => appTest.reset());
  afterEach(() => appTest.reset());

  it("returns null when the shared client is null (env unset) — no throw", async () => {
    appTest.injectClient(null);
    assert.equal(await getSnapshotUsage(NOW), null);
  });

  it("returns null (no throw) when the table is empty", async () => {
    const { client } = makeSnapshotClient({ row: null });
    appTest.injectClient(client);
    assert.equal(await getSnapshotUsage(NOW), null);
  });

  it("returns null (no throw) when the query errors", async () => {
    const { client } = makeSnapshotClient({ error: { message: "down" } });
    appTest.injectClient(client);
    assert.equal(await getSnapshotUsage(NOW), null);
  });

  it("returns null (no throw) when the query throws", async () => {
    const { client } = makeSnapshotClient({ throwOn: true });
    appTest.injectClient(client);
    await assert.doesNotReject(getSnapshotUsage(NOW));
    assert.equal(await getSnapshotUsage(NOW), null);
  });

  it("queries the latest row: select cols, order observed_at desc, limit 1", async () => {
    const { client, captured } = makeSnapshotClient({ row: freshRow() });
    appTest.injectClient(client);
    await getSnapshotUsage(NOW);
    assert.equal(captured.table, "claude_quota_snapshots");
    assert.equal(captured.orderCol, "observed_at");
    assert.equal(captured.ascending, false);
    assert.equal(captured.limit, 1);
  });

  it("hydrates a fresh row into a MaxUsage (stale=false) without hitting the endpoint", async () => {
    const { client } = makeSnapshotClient({ row: freshRow() });
    appTest.injectClient(client);
    const u = await getSnapshotUsage(NOW);
    assert.ok(u);
    assert.equal(u!.weeklyPct, 91);
    assert.equal(u!.sessionPct, 29);
    assert.equal(u!.weekResetsAt, "2026-06-09T00:00:00Z");
    assert.equal(u!.sessionResetsAt, "2026-06-04T17:00:00Z");
    assert.equal(u!.weekly.resetsAt, "2026-06-09T00:00:00Z");
    assert.equal(u!.session.resetsAt, "2026-06-04T17:00:00Z");
    assert.equal(u!.stale, false);
    assert.ok(u!.ageMs >= 0 && u!.ageMs < 20 * 60_000);
  });

  it("flags a snapshot older than the default 20-min threshold as stale (last-good still returned)", async () => {
    const { client } = makeSnapshotClient({
      row: freshRow({ observed_at: new Date(NOW - 45 * 60_000).toISOString() }) // 45 min old
    });
    appTest.injectClient(client);
    const u = await getSnapshotUsage(NOW);
    assert.ok(u, "must still return last-good (never fail-open silently)");
    assert.equal(u!.stale, true);
    // values still present so the hard caps keep applying.
    assert.equal(u!.weeklyPct, 91);
    assert.equal(u!.sessionPct, 29);
  });

  it("clamps junk percents and tolerates missing reset columns", async () => {
    const { client } = makeSnapshotClient({
      row: freshRow({ session_used_pct: 150, week_used_pct: "abc", week_resets_at: null, session_resets_at: undefined })
    });
    appTest.injectClient(client);
    const u = await getSnapshotUsage(NOW);
    assert.equal(u!.sessionPct, 100);
    assert.equal(u!.weeklyPct, 0);
    assert.equal(u!.weekResetsAt, null);
    assert.equal(u!.sessionResetsAt, null);
  });
});

describe("quota-snapshot → auto-pause integration", () => {
  beforeEach(() => appTest.reset());
  afterEach(() => appTest.reset());

  it("auto-pause hard cap trips on a snapshot weekly%>=cap", async () => {
    const { client } = makeSnapshotClient({ row: freshRow({ week_used_pct: 92 }) });
    appTest.injectClient(client);
    const usage = await getSnapshotUsage(NOW);
    const decision = decidePause(usage, { weeklyPausePct: 90, sessionPausePct: 95 }, NOW);
    assert.equal(decision.pause, true);
    assert.equal(decision.window, "weekly");
    assert.equal(decision.pct, 92);
    assert.equal(decision.resetsAt, "2026-06-09T00:00:00Z");
  });

  it("auto-pause does NOT trip on an under-cap snapshot", async () => {
    const { client } = makeSnapshotClient({ row: freshRow({ week_used_pct: 40, session_used_pct: 10 }) });
    appTest.injectClient(client);
    const usage = await getSnapshotUsage(NOW);
    const decision = decidePause(usage, { weeklyPausePct: 90, sessionPausePct: 95 }, NOW);
    assert.equal(decision.pause, false);
  });

  it("a stale snapshot STILL applies the last-good hard cap (no silent fail-open)", async () => {
    const { client } = makeSnapshotClient({
      row: freshRow({ week_used_pct: 96, observed_at: new Date(NOW - 60 * 60_000).toISOString() })
    });
    appTest.injectClient(client);
    const usage = await getSnapshotUsage(NOW);
    assert.equal(usage!.stale, true);
    const decision = decidePause(usage, { weeklyPausePct: 90, sessionPausePct: 95 }, NOW);
    assert.equal(decision.pause, true, "stale-but-over-cap must still pause");
    assert.equal(decision.window, "weekly");
  });
});
