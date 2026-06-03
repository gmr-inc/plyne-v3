/**
 * auto-merge-loop tests — the pure PR-URL parser. The loop's I/O paths
 * (gh/Notion) are exercised in integration; here we lock the URL parsing that
 * decides which PR to gate.
 *
 * Run locally: node --import tsx --test src/orchestrator/__tests__/auto-merge-loop.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePrUrl } from "../auto-merge-loop.js";

describe("parsePrUrl", () => {
  it("parses a standard PR URL", () => {
    assert.deepEqual(parsePrUrl("https://github.com/gmr-inc/plyne-v3/pull/42"), {
      owner: "gmr-inc",
      repo: "plyne-v3",
      number: 42
    });
  });

  it("parses a URL with a trailing path/fragment", () => {
    assert.deepEqual(parsePrUrl("https://github.com/gmr-inc/brynx/pull/7/files"), {
      owner: "gmr-inc",
      repo: "brynx",
      number: 7
    });
  });

  it("returns null for null/empty/non-PR URLs", () => {
    assert.equal(parsePrUrl(null), null);
    assert.equal(parsePrUrl(""), null);
    assert.equal(parsePrUrl("https://github.com/gmr-inc/plyne-v3/issues/3"), null);
    assert.equal(parsePrUrl("not a url"), null);
  });
});
