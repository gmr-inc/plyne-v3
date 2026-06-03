/**
 * pacing tests — run under `node --test`.
 *
 * computePacing is a pure function of (weekUsedPct, now, weekResetsAt):
 *   - elapsedFrac = clamp((now - (resetsAt - 7d)) / 7d, 0, 1)
 *   - paceTargetPct = elapsedFrac * 100
 *   - projectedEndPct = elapsedFrac > 0 ? weekUsedPct / elapsedFrac : 0
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computePacing } from "../pacing.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RESET = "2026-06-08T00:00:00Z";
const RESET_MS = Date.parse(RESET);
const START_MS = RESET_MS - WEEK_MS; // 2026-06-01T00:00:00Z

function approx(actual: number, expected: number, eps = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !~= ${expected}`);
}

describe("pacing / computePacing", () => {
  it("at window start: elapsedFrac 0, no projection", () => {
    const p = computePacing(0, START_MS, RESET);
    approx(p.elapsedFrac, 0);
    approx(p.paceTargetPct, 0);
    approx(p.projectedEndPct, 0);
  });

  it("one day in (1/7), used == pace target → projects exactly 100%", () => {
    const oneDayIn = START_MS + WEEK_MS / 7;
    const p = computePacing(100 / 7, oneDayIn, RESET);
    approx(p.elapsedFrac, 1 / 7);
    approx(p.paceTargetPct, 100 / 7);
    approx(p.projectedEndPct, 100, 1e-4);
  });

  it("burning hot: 1 day in but already 29% used → projects ~203%", () => {
    const oneDayIn = START_MS + WEEK_MS / 7;
    const p = computePacing(29, oneDayIn, RESET);
    approx(p.elapsedFrac, 1 / 7);
    approx(p.projectedEndPct, 29 * 7, 1e-4);
  });

  it("sustainable: halfway through, 30% used → projects 60% (under 100)", () => {
    const halfway = START_MS + WEEK_MS / 2;
    const p = computePacing(30, halfway, RESET);
    approx(p.elapsedFrac, 0.5);
    approx(p.paceTargetPct, 50);
    approx(p.projectedEndPct, 60);
  });

  it("self-healing: same 29% used but later in week → projection falls", () => {
    const day1 = computePacing(29, START_MS + WEEK_MS / 7, RESET).projectedEndPct;
    const day5 = computePacing(29, START_MS + (5 * WEEK_MS) / 7, RESET).projectedEndPct;
    assert.ok(day5 < day1, "projection should fall as the week elapses at constant usage");
    approx(day5, (29 * 7) / 5, 1e-4);
  });

  it("clamps elapsedFrac to [0,1] (past reset / before start)", () => {
    assert.equal(computePacing(50, RESET_MS + WEEK_MS, RESET).elapsedFrac, 1);
    assert.equal(computePacing(50, START_MS - WEEK_MS, RESET).elapsedFrac, 0);
  });

  it("missing/unparseable resetsAt → neutral reading (never trips a pause)", () => {
    for (const bad of [null, undefined, "", "not-a-date"]) {
      const p = computePacing(99, Date.now(), bad as string | null | undefined);
      assert.equal(p.elapsedFrac, 0);
      assert.equal(p.paceTargetPct, 0);
      assert.equal(p.projectedEndPct, 0);
    }
  });

  it("non-finite weekUsedPct treated as 0", () => {
    const p = computePacing(Number.NaN, START_MS + WEEK_MS / 2, RESET);
    approx(p.projectedEndPct, 0);
  });
});
