/**
 * IngestDedupe tests — runs under `node --test` (Node 22 built-in runner)
 * so we don't need to pull in jest/vitest. v3 already uses `node --test`
 * for the smoke suite; ingestion tests follow the same convention.
 *
 * Run locally: `node --import tsx --test src/ingestion/__tests__/*.test.ts`
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IngestDedupe } from "../dedupe.js";
import type { IngestSignal } from "../types.js";

function signal(overrides: Partial<IngestSignal> = {}): IngestSignal {
  return {
    source: "sentry",
    externalId: "issue-123",
    product: "brynx",
    title: "TypeError: Cannot read property 'foo' of undefined",
    severity: "P1",
    evidenceUrl: "https://sentry.io/issues/123",
    details: "x",
    ...overrides
  };
}

describe("IngestDedupe", () => {
  it("emits the first time a signature is seen", () => {
    const d = new IngestDedupe();
    assert.equal(d.shouldEmit(signal()), true);
  });

  it("dedupes the second time within the TTL window", () => {
    const d = new IngestDedupe();
    assert.equal(d.shouldEmit(signal()), true);
    assert.equal(d.shouldEmit(signal()), false);
  });

  it("differentiates by source", () => {
    const d = new IngestDedupe();
    assert.equal(d.shouldEmit(signal({ source: "sentry" })), true);
    assert.equal(d.shouldEmit(signal({ source: "betterstack" })), true);
  });

  it("differentiates by product", () => {
    const d = new IngestDedupe();
    assert.equal(d.shouldEmit(signal({ product: "brynx" })), true);
    assert.equal(d.shouldEmit(signal({ product: "marketear" })), true);
  });

  it("differentiates by title (different sha1)", () => {
    const d = new IngestDedupe();
    assert.equal(d.shouldEmit(signal({ title: "one" })), true);
    assert.equal(d.shouldEmit(signal({ title: "two" })), true);
  });

  it("collapses title case + whitespace differences", () => {
    const d = new IngestDedupe();
    assert.equal(d.shouldEmit(signal({ title: "FOO bar" })), true);
    assert.equal(d.shouldEmit(signal({ title: "  foo BAR  " })), false);
  });

  it("re-emits after TTL expires", () => {
    let now = 1_000_000;
    const d = new IngestDedupe({ ttlMs: 100, now: () => now });
    assert.equal(d.shouldEmit(signal()), true);
    now += 50;
    assert.equal(d.shouldEmit(signal()), false);
    now += 100;
    assert.equal(d.shouldEmit(signal()), true);
  });

  it("computes a stable signature shape", () => {
    const d = new IngestDedupe();
    const sig = d.signature(signal());
    assert.match(sig, /^sentry:brynx:[a-f0-9]{12}$/);
  });
});
