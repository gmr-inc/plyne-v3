/**
 * Self-observability smoke tests — prove the three sinks are SAFE TO DEPLOY
 * INACTIVE. With no SENTRY_DSN / BETTERSTACK_* / BRAINTRUST_API_KEY set (the
 * state in CI + a greenfield VPS), every helper must no-op WITHOUT throwing —
 * the whole point is that observability is additive and can never crash the
 * daemon. Runs under `node --test`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  initSentry,
  sentryEnabled,
  captureException,
  captureMessage,
  flush
} from "../sentry.js";
import {
  betterstackEnabled,
  createBetterstackPinoStream,
  flushBetterstackLogs,
  startBetterstackTraces
} from "../betterstack.js";
import {
  braintrustEnabled,
  initBraintrust,
  logExecutorRun,
  flushBraintrust
} from "../braintrust.js";

// Snapshot + clear the observability env so the suite is deterministic.
const SAVED: Record<string, string | undefined> = {};
const KEYS = [
  "SENTRY_DSN",
  "BETTERSTACK_SOURCE_TOKEN",
  "BETTERSTACK_INGESTING_HOST",
  "BRAINTRUST_API_KEY"
];

before(() => {
  for (const k of KEYS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
});

after(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe("observability: Sentry no-op when SENTRY_DSN unset", () => {
  it("initSentry returns false and reports disabled", () => {
    assert.equal(initSentry(), false);
    assert.equal(sentryEnabled(), false);
  });

  it("captureException / captureMessage return undefined and never throw", () => {
    assert.equal(captureException(new Error("boom"), { phase: "test" }), undefined);
    assert.equal(captureMessage("hello", "error", { x: 1 }), undefined);
  });

  it("flush resolves without throwing", async () => {
    await assert.doesNotReject(() => flush(50));
  });
});

describe("observability: BetterStack no-op when source creds unset", () => {
  it("betterstackEnabled is false", () => {
    assert.equal(betterstackEnabled(), false);
  });

  it("createBetterstackPinoStream returns undefined (logger falls back to stdout)", () => {
    assert.equal(createBetterstackPinoStream(), undefined);
  });

  it("startBetterstackTraces resolves false; flush never throws", async () => {
    assert.equal(await startBetterstackTraces(), false);
    await assert.doesNotReject(() => flushBetterstackLogs());
  });
});

describe("observability: Braintrust no-op when BRAINTRUST_API_KEY unset", () => {
  it("braintrustEnabled is false; initBraintrust returns false", () => {
    assert.equal(braintrustEnabled(), false);
    assert.equal(initBraintrust(), false);
  });

  it("logExecutorRun is a silent no-op (never throws)", () => {
    assert.doesNotThrow(() =>
      logExecutorRun(
        { taskId: "t1", externalId: "V3-TEST-1", model: "claude-opus-4-8" },
        { exitCode: 0, durationMs: 1234, stdout: "ok", branch: "feat/x" }
      )
    );
  });

  it("flushBraintrust resolves without throwing", async () => {
    await assert.doesNotReject(() => flushBraintrust());
  });
});
