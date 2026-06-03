/**
 * max-usage tests — run under `node --test` (no jest/vitest).
 *
 * Covers:
 *   - parseUsageResponse: percent fields (whole-number), resets_at, clamping,
 *     and tolerance of missing/partial windows
 *   - readOAuthAccessToken: reads claudeAiOauth.accessToken; returns null on
 *     missing file / bad JSON / missing token (never throws)
 *   - getMaxUsage: caching (~60s), 401/non-200 → null, network error → null,
 *     happy path parses the live shape — all best-effort (never throws)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseUsageResponse,
  readOAuthAccessToken,
  getMaxUsage,
  __test as usageTest
} from "../max-usage.js";

const LIVE_SHAPE = {
  five_hour: { utilization: 29.0, resets_at: "2026-06-03T18:00:00Z" },
  seven_day: { utilization: 91.0, resets_at: "2026-06-09T00:00:00Z" },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 40.0, resets_at: "2026-06-09T00:00:00Z" },
  extra_usage: { is_enabled: false }
};

describe("max-usage / parseUsageResponse", () => {
  it("parses whole-number percents + resets_at for both windows", () => {
    const u = parseUsageResponse(LIVE_SHAPE, 1000);
    assert.equal(u.sessionPct, 29);
    assert.equal(u.weeklyPct, 91);
    assert.equal(u.session.resetsAt, "2026-06-03T18:00:00Z");
    assert.equal(u.weekly.resetsAt, "2026-06-09T00:00:00Z");
    assert.equal(u.sessionResetsAt, "2026-06-03T18:00:00Z");
    assert.equal(u.weekResetsAt, "2026-06-09T00:00:00Z");
    assert.equal(u.fetchedAt, 1000);
  });

  it("clamps out-of-range utilization to 0..100", () => {
    const u = parseUsageResponse({ five_hour: { utilization: 150 }, seven_day: { utilization: -5 } });
    assert.equal(u.sessionPct, 100);
    assert.equal(u.weeklyPct, 0);
  });

  it("tolerates missing windows (defaults to 0 / null, never throws)", () => {
    const u = parseUsageResponse({});
    assert.equal(u.sessionPct, 0);
    assert.equal(u.weeklyPct, 0);
    assert.equal(u.session.resetsAt, null);
    assert.equal(u.weekly.resetsAt, null);
  });

  it("tolerates a fully empty/garbage body", () => {
    assert.doesNotThrow(() => parseUsageResponse(null));
    assert.doesNotThrow(() => parseUsageResponse("nonsense"));
  });
});

describe("max-usage / readOAuthAccessToken", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "maxusage-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads claudeAiOauth.accessToken from the file", () => {
    const p = path.join(dir, "creds.json");
    fs.writeFileSync(p, JSON.stringify({ claudeAiOauth: { accessToken: "tok-123", subscriptionType: "max" } }));
    assert.equal(readOAuthAccessToken(p), "tok-123");
  });

  it("returns null when the file is missing (no throw)", () => {
    assert.equal(readOAuthAccessToken(path.join(dir, "nope.json")), null);
  });

  it("returns null on invalid JSON (no throw)", () => {
    const p = path.join(dir, "bad.json");
    fs.writeFileSync(p, "{not json");
    assert.equal(readOAuthAccessToken(p), null);
  });

  it("returns null when accessToken is missing/empty (no throw)", () => {
    const p = path.join(dir, "empty.json");
    fs.writeFileSync(p, JSON.stringify({ claudeAiOauth: { accessToken: "" } }));
    assert.equal(readOAuthAccessToken(p), null);
  });
});

describe("max-usage / getMaxUsage", () => {
  let dir: string;
  let credsPath: string;
  beforeEach(() => {
    usageTest.reset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "maxusage-g-"));
    credsPath = path.join(dir, "creds.json");
    fs.writeFileSync(credsPath, JSON.stringify({ claudeAiOauth: { accessToken: "tok-abc" } }));
    process.env["CLAUDE_CREDENTIALS_PATH"] = credsPath;
  });
  afterEach(() => {
    usageTest.reset();
    delete process.env["CLAUDE_CREDENTIALS_PATH"];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the token is unreadable (no throw)", async () => {
    fs.rmSync(credsPath);
    const u = await getMaxUsage({ force: true });
    assert.equal(u, null);
  });

  it("sends the two required headers and parses a 200 body", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    usageTest.injectFetch((async (url: string, init: { headers?: Record<string, string> }) => {
      seenUrl = url;
      seenHeaders = init?.headers ?? {};
      return { ok: true, status: 200, async json() { return LIVE_SHAPE; } };
    }) as unknown as typeof fetch);

    const u = await getMaxUsage({ force: true });
    assert.ok(u);
    assert.equal(u!.weeklyPct, 91);
    assert.equal(u!.sessionPct, 29);
    assert.match(seenUrl, /\/api\/oauth\/usage$/);
    assert.equal(seenHeaders["Authorization"], "Bearer tok-abc");
    assert.equal(seenHeaders["anthropic-beta"], "oauth-2025-04-20");
  });

  it("returns null on a 401 (expired token) without throwing", async () => {
    usageTest.injectFetch((async () => ({ ok: false, status: 401, async json() { return {}; } })) as unknown as typeof fetch);
    const u = await getMaxUsage({ force: true });
    assert.equal(u, null);
  });

  it("returns null on a network/fetch throw without propagating", async () => {
    usageTest.injectFetch((async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch);
    const u = await getMaxUsage({ force: true });
    assert.equal(u, null);
  });

  it("caches within the TTL (one fetch for two reads)", async () => {
    let calls = 0;
    usageTest.injectFetch((async () => { calls++; return { ok: true, status: 200, async json() { return LIVE_SHAPE; } }; }) as unknown as typeof fetch);
    const a = await getMaxUsage();
    const b = await getMaxUsage();
    assert.equal(calls, 1);
    assert.equal(a!.weeklyPct, b!.weeklyPct);
  });
});
