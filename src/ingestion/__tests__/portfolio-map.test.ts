/**
 * portfolio-map tests — verify the static product/repo registry stays in
 * sync with what the rest of the module assumes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lookupRepo, isKnownProduct, PORTFOLIO } from "../portfolio-map.js";

describe("portfolio-map", () => {
  it("lookupRepo resolves a known product", () => {
    assert.equal(lookupRepo("brynx"), "gmr-inc/brynx");
    assert.equal(lookupRepo("dtwin"), "gmr-inc/dtwin-app");
    assert.equal(lookupRepo("klenux"), "gmr-inc/uxtwin");
  });

  it("lookupRepo returns null for unknown products", () => {
    assert.equal(lookupRepo("does-not-exist"), null);
    assert.equal(lookupRepo(""), null);
  });

  it("isKnownProduct is the negation of lookupRepo === null", () => {
    assert.equal(isKnownProduct("brynx"), true);
    assert.equal(isKnownProduct("???"), false);
  });

  it("PORTFOLIO covers all GMR product codes from the GMR taxonomy", () => {
    // Subset that must exist for ingestion to work — memory
    // reference_gmr_product_codes.md.
    const required = ["marketear", "brynx", "crewrev", "dtwin", "geoky", "klenux", "graph", "cto"];
    for (const r of required) {
      assert.ok(isKnownProduct(r), `missing required product key: ${r}`);
    }
  });

  it("every entry has a repo in org/name shape", () => {
    for (const entry of PORTFOLIO) {
      assert.match(entry.repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, `bad repo: ${entry.repo}`);
    }
  });
});
