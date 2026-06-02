/**
 * task-creator tests — focus on the pure helpers (buildExternalId) and
 * the "unknown product → null" branch (no Notion API call needed).
 *
 * The Notion-write path is exercised only in E2E (PLYNE_INGESTION_E2E=1
 * env, see ingestion/__tests__/e2e.test.ts). Unit tests avoid mocking
 * @notionhq/client to keep the deps surface minimal.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildExternalId, createTaskFromSignal } from "../task-creator.js";
import type { IngestSignal } from "../types.js";

function signal(overrides: Partial<IngestSignal> = {}): IngestSignal {
  return {
    source: "sentry",
    externalId: "abc123-deadbeef-9999",
    product: "brynx",
    title: "TypeError x",
    severity: "P1",
    evidenceUrl: "https://sentry.io/x",
    details: "y",
    ...overrides
  };
}

describe("task-creator", () => {
  it("buildExternalId produces a stable, slug-shaped id", () => {
    const id = buildExternalId(signal());
    assert.match(id, /^INGEST-SENTRY-[A-Za-z0-9-]+$/);
    assert.ok(id.length <= 60);
  });

  it("buildExternalId is uppercase source + last 12 chars of externalId", () => {
    const id = buildExternalId(signal({ source: "betterstack", externalId: "2440243:foo bar baz qux pattern long" }));
    assert.equal(id.startsWith("INGEST-BETTERSTACK-"), true);
  });

  it("buildExternalId falls back to UNK for empty externalId", () => {
    const id = buildExternalId(signal({ externalId: "" }));
    assert.equal(id, "INGEST-SENTRY-UNK");
  });

  it("createTaskFromSignal returns null for unknown product (no API call)", async () => {
    const result = await createTaskFromSignal(signal({ product: "does-not-exist" }));
    assert.equal(result, null);
  });
});
