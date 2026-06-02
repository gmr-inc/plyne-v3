/**
 * E2E-flow tests — exercise the full dedupe + severity-gate pipeline
 * without hitting Notion. Uses the public ingestion module surface
 * (sharedDedupe + IngestDedupe + buildExternalId) and a fake "create
 * task" callback to assert end-to-end behaviour matches the spec:
 *
 *   - same signal twice → one task only (dedupe)
 *   - P2/P3 → no task (log-only severity gate)
 *   - unknown product → no task (portfolio gate)
 *
 * The real Notion API path is exercised separately by `npm run smoke`
 * + manual E2E (see report at PR description).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IngestDedupe } from "../dedupe.js";
import { buildExternalId } from "../task-creator.js";
import { isKnownProduct } from "../portfolio-map.js";
import type { IngestSignal, Severity } from "../types.js";

function signal(overrides: Partial<IngestSignal> = {}): IngestSignal {
  return {
    source: "sentry",
    externalId: "issue-xyz",
    product: "brynx",
    title: "TypeError x",
    severity: "P1",
    evidenceUrl: "https://sentry.io/x",
    details: "",
    ...overrides
  };
}

/**
 * Mini pipeline mirroring what each collector does:
 *   1. severity gate (only P0/P1 create tasks)
 *   2. portfolio gate (unknown product → skip)
 *   3. dedupe (signature already seen → skip)
 *   4. emit (in real life: createTaskFromSignal())
 */
function pipeline(
  s: IngestSignal,
  dedupe: IngestDedupe,
  emit: (s: IngestSignal) => void
): "emitted" | "skip-severity" | "skip-product" | "skip-dedupe" {
  const SEVERITIES_THAT_CREATE_TASKS: ReadonlyArray<Severity> = ["P0", "P1"];
  if (!SEVERITIES_THAT_CREATE_TASKS.includes(s.severity)) return "skip-severity";
  if (!isKnownProduct(s.product)) return "skip-product";
  if (!dedupe.shouldEmit(s)) return "skip-dedupe";
  emit(s);
  return "emitted";
}

describe("ingestion E2E flow", () => {
  it("creates one task when the same signal arrives twice", () => {
    const dedupe = new IngestDedupe();
    const emitted: IngestSignal[] = [];
    const r1 = pipeline(signal(), dedupe, (s) => emitted.push(s));
    const r2 = pipeline(signal(), dedupe, (s) => emitted.push(s));
    assert.equal(r1, "emitted");
    assert.equal(r2, "skip-dedupe");
    assert.equal(emitted.length, 1);
  });

  it("skips P2 signals (log-only severity gate)", () => {
    const dedupe = new IngestDedupe();
    const emitted: IngestSignal[] = [];
    const r = pipeline(signal({ severity: "P2" }), dedupe, (s) => emitted.push(s));
    assert.equal(r, "skip-severity");
    assert.equal(emitted.length, 0);
  });

  it("skips P3 signals (log-only severity gate)", () => {
    const dedupe = new IngestDedupe();
    const emitted: IngestSignal[] = [];
    const r = pipeline(signal({ severity: "P3" }), dedupe, (s) => emitted.push(s));
    assert.equal(r, "skip-severity");
    assert.equal(emitted.length, 0);
  });

  it("skips unknown products (portfolio gate)", () => {
    const dedupe = new IngestDedupe();
    const emitted: IngestSignal[] = [];
    const r = pipeline(signal({ product: "non-existent" }), dedupe, (s) => emitted.push(s));
    assert.equal(r, "skip-product");
    assert.equal(emitted.length, 0);
  });

  it("emits multiple distinct signals from the same source", () => {
    const dedupe = new IngestDedupe();
    const emitted: IngestSignal[] = [];
    pipeline(signal({ title: "err A" }), dedupe, (s) => emitted.push(s));
    pipeline(signal({ title: "err B" }), dedupe, (s) => emitted.push(s));
    pipeline(signal({ title: "err C" }), dedupe, (s) => emitted.push(s));
    assert.equal(emitted.length, 3);
  });

  it("external_id is stable across sources / collectors", () => {
    assert.equal(
      buildExternalId({ ...signal(), source: "sentry", externalId: "abcdef1234567890" }),
      "INGEST-SENTRY-ef1234567890"
    );
    // src-42:pattern-foo-bar → strip non-alphanum (drops "-" preserved, ":") → src-42patternfoobar → last 12.
    // Note: the regex keeps "-" + alnum, strips ":". So "src-42:pattern-foo-bar" → "src-42pattern-foo-bar"
    // last 12 chars: "tern-foo-bar".
    assert.equal(
      buildExternalId({ ...signal(), source: "betterstack", externalId: "src-42:pattern-foo-bar" }),
      "INGEST-BETTERSTACK-tern-foo-bar"
    );
  });
});
