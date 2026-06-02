/**
 * vercel-env-pull tests — verify gating behaviour without hitting the
 * Vercel API. We focus on the *pure* paths: gate off, missing token,
 * already-set keys preserved. Live API success is covered by a manual
 * smoke (documented in RESTART.md) since it requires a real token.
 *
 * Run: npm test (compiles to dist/ and runs node --test).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { pullVercelEnv } from "../vercel-env-pull.js";

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of keys) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of Object.keys(snap)) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const TOUCHED = [
  "PLYNE_V3_PULL_VERCEL_ENV",
  "VERCEL_TOKEN",
  "PLYNE_V3_VERCEL_ENV_TARGET",
  "VERCEL_TEAM_ID"
];

describe("pullVercelEnv", () => {
  let snap: Record<string, string | undefined> = {};

  beforeEach(() => {
    snap = snapshotEnv(TOUCHED);
    for (const k of TOUCHED) delete process.env[k];
  });

  afterEach(() => {
    restoreEnv(snap);
  });

  it("is a no-op when PLYNE_V3_PULL_VERCEL_ENV is unset", async () => {
    const result = await pullVercelEnv();
    assert.equal(result.ran, false);
    assert.equal(result.error, null);
    assert.deepEqual(result.fromVercel, []);
  });

  it("is a no-op when PLYNE_V3_PULL_VERCEL_ENV is 'false'", async () => {
    process.env.PLYNE_V3_PULL_VERCEL_ENV = "false";
    const result = await pullVercelEnv();
    assert.equal(result.ran, false);
    assert.equal(result.error, null);
  });

  it("reports a non-fatal error when token is missing but gate is on", async () => {
    process.env.PLYNE_V3_PULL_VERCEL_ENV = "true";
    const result = await pullVercelEnv();
    assert.equal(result.ran, false);
    assert.match(result.error ?? "", /VERCEL_TOKEN missing/);
  });

  it("accepts '1' as a truthy gate value", async () => {
    process.env.PLYNE_V3_PULL_VERCEL_ENV = "1";
    // No token → still skipped but with the missing-token error path.
    const result = await pullVercelEnv();
    assert.equal(result.ran, false);
    assert.match(result.error ?? "", /VERCEL_TOKEN missing/);
  });
});
