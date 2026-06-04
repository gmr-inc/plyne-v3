/**
 * Auto-promote policy tests — `node --test` (Node 22 built-in runner), same
 * convention as the rest of the ingestion suite.
 *
 * Run locally: `node --import tsx --test src/ingestion/__tests__/auto-promote.test.ts`
 *
 * Covers the PURE policy (evaluatePromotion) exhaustively + the rate limiter +
 * the dry-run/live behaviour of autoPromote() with injected deps (no Notion).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePromotion,
  looksSynthetic,
  parseRepoAllowlist,
  PromotionRateLimiter,
  autoPromote,
  __test,
  type PromotionContext,
  type PromoteDeps
} from "../auto-promote.js";
import type { IngestSignal } from "../types.js";

const SANDBOX = "gmr-inc/plyne-autobugs-sandbox";

function signal(overrides: Partial<IngestSignal> = {}): IngestSignal {
  return {
    source: "sentry",
    externalId: "issue-123",
    product: "cto",
    title: "TypeError: Cannot read property 'foo' of undefined",
    severity: "P1",
    evidenceUrl: "https://sentry.io/issues/123",
    details: "x",
    ...overrides
  };
}

function ctx(overrides: Partial<PromotionContext> = {}): PromotionContext {
  return {
    repoAllowlist: new Set([SANDBOX]),
    repo: SANDBOX,
    minAgeMs: 0,
    nowMs: Date.now(),
    openBacklog: 0,
    maxOpenBacklog: 10,
    rateLimitOk: true,
    ...overrides
  };
}

describe("evaluatePromotion — happy path", () => {
  it("promotes a real, allowlisted P1 signal", () => {
    assert.deepEqual(evaluatePromotion(signal(), ctx()), { promote: true });
  });
  it("promotes a P0", () => {
    assert.deepEqual(evaluatePromotion(signal({ severity: "P0" }), ctx()), { promote: true });
  });
});

describe("evaluatePromotion — guardrails reject", () => {
  it("rejects P2 (below P1)", () => {
    const d = evaluatePromotion(signal({ severity: "P2" }), ctx());
    assert.equal(d.promote, false);
    assert.match((d as { reason: string }).reason, /severity_below_p1/);
  });

  it("rejects synthetic/demo titles even from a real source", () => {
    const d = evaluatePromotion(
      signal({ title: "[demo] TypeError boom", severity: "P0" }),
      ctx()
    );
    assert.equal(d.promote, false);
    assert.equal((d as { reason: string }).reason, "synthetic_or_demo");
  });

  it("rejects the E2E evidence smoke synthetic row", () => {
    const d = evaluatePromotion(
      signal({ title: "E2E evidence smoke — synthetic Sentry signal", severity: "P1" }),
      ctx()
    );
    assert.equal(d.promote, false);
    assert.equal((d as { reason: string }).reason, "synthetic_or_demo");
  });

  it("rejects a vendor-outage signal (not our infra to fix)", () => {
    const d = evaluatePromotion(signal({ vendor: true }), ctx());
    assert.equal(d.promote, false);
    assert.equal((d as { reason: string }).reason, "vendor_outage_not_fixable");
  });

  it("rejects a repo NOT in the allowlist (fail-closed)", () => {
    const d = evaluatePromotion(signal(), ctx({ repoAllowlist: new Set(["gmr-inc/other"]) }));
    assert.equal(d.promote, false);
    assert.match((d as { reason: string }).reason, /repo_not_allowlisted/);
  });

  it("rejects when the allowlist is empty (promotes nothing by default)", () => {
    const d = evaluatePromotion(signal(), ctx({ repoAllowlist: new Set() }));
    assert.equal(d.promote, false);
    assert.match((d as { reason: string }).reason, /repo_not_allowlisted/);
  });

  it("rejects an unresolved (empty) repo", () => {
    const d = evaluatePromotion(signal(), ctx({ repo: "" }));
    assert.equal(d.promote, false);
    assert.equal((d as { reason: string }).reason, "unknown_repo");
  });

  it("respects the operator-backlog circuit breaker", () => {
    const d = evaluatePromotion(signal(), ctx({ openBacklog: 10, maxOpenBacklog: 10 }));
    assert.equal(d.promote, false);
    assert.match((d as { reason: string }).reason, /operator_backlog_full/);
  });

  it("respects the rate limit", () => {
    const d = evaluatePromotion(signal(), ctx({ rateLimitOk: false }));
    assert.equal(d.promote, false);
    assert.equal((d as { reason: string }).reason, "rate_limited");
  });

  it("rejects a too-fresh signal under the age gate", () => {
    const now = 1_000_000_000;
    const d = evaluatePromotion(
      signal({ firstSeenAt: new Date(now - 1000).toISOString() }),
      ctx({ nowMs: now, minAgeMs: 60_000 })
    );
    assert.equal(d.promote, false);
    assert.match((d as { reason: string }).reason, /too_fresh/);
  });

  it("allows a sufficiently-aged signal under the age gate", () => {
    const now = 1_000_000_000;
    const d = evaluatePromotion(
      signal({ firstSeenAt: new Date(now - 120_000).toISOString() }),
      ctx({ nowMs: now, minAgeMs: 60_000 })
    );
    assert.deepEqual(d, { promote: true });
  });
});

describe("looksSynthetic", () => {
  it("flags [demo], synthetic, smoke, and demo ids", () => {
    assert.equal(looksSynthetic(signal({ title: "[demo] x" })), true);
    assert.equal(looksSynthetic(signal({ title: "E2E evidence smoke — x" })), true);
    assert.equal(looksSynthetic(signal({ externalId: "signal_id_demo_001" })), true);
    assert.equal(looksSynthetic(signal({ externalId: "demo-monitor-bx" })), true);
    assert.equal(looksSynthetic(signal({ title: "real NPE crash" })), false);
  });
});

describe("parseRepoAllowlist", () => {
  it("parses comma-separated, trims, drops empties", () => {
    const s = parseRepoAllowlist(" gmr-inc/a , gmr-inc/b ,, ");
    assert.deepEqual([...s].sort(), ["gmr-inc/a", "gmr-inc/b"]);
  });
  it("empty string → empty set (promotes nothing)", () => {
    assert.equal(parseRepoAllowlist("").size, 0);
  });
});

describe("PromotionRateLimiter", () => {
  it("allows up to maxPerWindow then blocks", () => {
    let t = 0;
    const rl = new PromotionRateLimiter(2, 1000, () => t);
    assert.equal(rl.hasCapacity(), true);
    rl.record();
    rl.record();
    assert.equal(rl.hasCapacity(), false);
  });
  it("frees capacity once the window slides past", () => {
    let t = 0;
    const rl = new PromotionRateLimiter(1, 1000, () => t);
    rl.record();
    assert.equal(rl.hasCapacity(), false);
    t = 1500; // window elapsed
    assert.equal(rl.hasCapacity(), true);
  });
});

/**
 * autoPromote() integration with injected deps. We can't easily flip
 * PLYNE_AUTO_PROMOTE per-case (env is read at module load via loadEnv cache),
 * so these assert the DRY-RUN default path (flag off) — the safe-by-default
 * behaviour that ships to prod: policy qualifies the task but performs NO write.
 */
describe("autoPromote — dry-run default (flag OFF)", () => {
  beforeEach(() => __test.resetLimiter());

  function deps(): PromoteDeps & { promoted: string[] } {
    const promoted: string[] = [];
    return {
      promoted,
      countOpenBacklog: async () => 0,
      promoteTask: async (_pageId, newExternalId) => {
        promoted.push(newExternalId);
      }
    };
  }

  it("qualifies a real P1 but does NOT write when the flag is off", async () => {
    const d = deps();
    const res = await autoPromote(
      { signal: signal(), pageId: "page-1", externalId: "INGEST-SENTRY-ABC", repo: SANDBOX },
      d
    );
    // With PLYNE_AUTO_PROMOTE unset/false in the test env, this is a dry-run.
    assert.equal(res.dryRun, true);
    assert.equal(res.promoted, false);
    assert.equal(d.promoted.length, 0, "no Notion write in dry-run");
    // It still reports what it WOULD do.
    assert.equal(res.qualified, true);
    assert.equal(res.newExternalId, "V3-AUTO-SENTRY-ABC");
  });

  it("does not even qualify a demo signal (never promoted, even live)", async () => {
    const d = deps();
    const res = await autoPromote(
      {
        signal: signal({ title: "[demo] boom" }),
        pageId: "page-2",
        externalId: "INGEST-SENTRY-DEMO",
        repo: SANDBOX
      },
      d
    );
    assert.equal(res.qualified, false);
    assert.equal(res.promoted, false);
    assert.equal(d.promoted.length, 0);
  });
});
