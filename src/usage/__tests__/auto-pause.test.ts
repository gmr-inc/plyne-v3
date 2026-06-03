/**
 * auto-pause tests — run under `node --test`.
 *
 * Covers:
 *   - decidePause: weekly>=90 → pause, below → run, session>=95 → pause,
 *     null usage → run (best-effort, no pause)
 *   - AutoPauseGate: enters pause once (onEnterPause fires once), stays paused
 *     until resets_at, auto-resumes when window reset + usage dropped, re-arms
 *     when usage still over cap at horizon
 *   - reactive backstop: forcePauseFromLimitHit pauses + fires once
 *   - isLimitHit: detects the CLI's own "usage limit reached" / "rate limit"
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decidePause,
  AutoPauseGate,
  isLimitHit,
  resolveResumeAt
} from "../auto-pause.js";
import type { MaxUsage } from "../max-usage.js";

const TH = { weeklyPausePct: 90, sessionPausePct: 95 };

function usage(weeklyPct: number, sessionPct: number, weeklyReset = "2999-01-01T00:00:00Z"): MaxUsage {
  return {
    weeklyPct,
    sessionPct,
    weekly: { utilization: weeklyPct, resetsAt: weeklyReset },
    session: { utilization: sessionPct, resetsAt: "2999-01-01T00:00:00Z" },
    fetchedAt: 0
  };
}

describe("auto-pause / decidePause", () => {
  it("pauses when weekly >= threshold", () => {
    const d = decidePause(usage(90, 10), TH);
    assert.equal(d.pause, true);
    assert.equal(d.window, "weekly");
    assert.equal(d.pct, 90);
  });

  it("runs when weekly just below threshold", () => {
    assert.equal(decidePause(usage(89, 10), TH).pause, false);
  });

  it("pauses when session >= threshold", () => {
    const d = decidePause(usage(10, 95), TH);
    assert.equal(d.pause, true);
    assert.equal(d.window, "session");
  });

  it("does NOT pause when usage is null (reader failed) — best-effort", () => {
    assert.equal(decidePause(null, TH).pause, false);
  });

  it("weekly takes precedence when both trip", () => {
    assert.equal(decidePause(usage(99, 99), TH).window, "weekly");
  });
});

describe("auto-pause / resolveResumeAt", () => {
  it("uses a future resets_at", () => {
    const now = Date.parse("2026-06-03T00:00:00Z");
    assert.equal(resolveResumeAt("2026-06-09T00:00:00Z", now, 1000), Date.parse("2026-06-09T00:00:00Z"));
  });
  it("falls back when resets_at is missing or in the past", () => {
    const now = Date.parse("2026-06-03T00:00:00Z");
    assert.equal(resolveResumeAt(null, now, 500), now + 500);
    assert.equal(resolveResumeAt("1999-01-01T00:00:00Z", now, 500), now + 500);
  });
});

describe("auto-pause / AutoPauseGate", () => {
  it("enters pause once and skips dispatch", () => {
    let t = 1000;
    const gate = new AutoPauseGate(TH, () => t);
    let entered = 0;
    const r1 = gate.evaluate(usage(95, 10), () => { entered++; });
    assert.equal(r1.dispatch, false);
    assert.equal(gate.isPaused(), true);
    assert.equal(entered, 1);
    // next cycle while still paused → no second onEnterPause fire
    t = 2000;
    const r2 = gate.evaluate(usage(95, 10), () => { entered++; });
    assert.equal(r2.dispatch, false);
    assert.equal(entered, 1);
  });

  it("auto-resumes once the window reset and usage dropped below cap", () => {
    let t = 1000;
    const resetAt = "2026-06-03T00:00:00Z";
    const gate = new AutoPauseGate(TH, () => t);
    gate.evaluate(usage(95, 10, resetAt));
    assert.equal(gate.isPaused(), true);
    // advance past the reset time, usage now low
    t = Date.parse(resetAt) + 1000;
    const r = gate.evaluate(usage(20, 10, resetAt));
    assert.equal(r.dispatch, true);
    assert.equal(gate.isPaused(), false);
  });

  it("re-arms (stays paused) when the horizon elapsed but usage is still over cap", () => {
    let t = 1000;
    const resetAt = "2026-06-03T00:00:00Z";
    const gate = new AutoPauseGate(TH, () => t);
    gate.evaluate(usage(95, 10, resetAt));
    t = Date.parse(resetAt) + 1000;
    const r = gate.evaluate(usage(95, 10, "2999-01-01T00:00:00Z"));
    assert.equal(r.dispatch, false);
    assert.equal(gate.isPaused(), true);
  });

  it("does not pause when usage reads null (reader failed)", () => {
    const gate = new AutoPauseGate(TH);
    const r = gate.evaluate(null);
    assert.equal(r.dispatch, true);
    assert.equal(gate.isPaused(), false);
  });

  it("reactive backstop: forcePauseFromLimitHit pauses + fires once", () => {
    let t = 1000;
    const gate = new AutoPauseGate(TH, () => t);
    let fired = 0;
    gate.forcePauseFromLimitHit("2999-01-01T00:00:00Z", () => { fired++; });
    assert.equal(gate.isPaused(), true);
    assert.equal(fired, 1);
    // second hit while paused → no second fire
    gate.forcePauseFromLimitHit("2999-01-01T00:00:00Z", () => { fired++; });
    assert.equal(fired, 1);
  });
});

describe("auto-pause / isLimitHit", () => {
  it("detects 'usage limit reached'", () => {
    assert.equal(isLimitHit("Error: Claude AI usage limit reached. Try again later."), true);
  });
  it("detects 'rate limit' (case-insensitive)", () => {
    assert.equal(isLimitHit("HTTP 429 Rate Limit exceeded"), true);
  });
  it("is false for normal output / null / empty", () => {
    assert.equal(isLimitHit("all good, PR opened"), false);
    assert.equal(isLimitHit(null), false);
    assert.equal(isLimitHit(""), false);
  });
});
