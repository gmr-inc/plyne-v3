/**
 * activity-stream tests — pure-function level. We avoid spinning up Express
 * + a real socket here; instead we exercise the framing + auth helpers
 * directly. The end-to-end SSE path is exercised manually post-deploy via
 * `curl -N -H 'Authorization: Bearer …' http://localhost:7733/activity/stream`.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  authorizeBearer,
  serializeActivityFrame,
  serializePingFrame
} from "../activity-stream.js";

// Tiny shims so we don't need to import express types in tests.
interface MockReq {
  header: (name: string) => string | undefined;
}
interface MockRes {
  statusCode?: number;
  body?: unknown;
  status: (code: number) => MockRes;
  json: (b: unknown) => MockRes;
}

function fakeReq(authHeader?: string): MockReq {
  return {
    header: (name: string) =>
      name.toLowerCase() === "authorization" ? authHeader : undefined
  };
}
function fakeRes(): MockRes {
  const res: MockRes = {
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    }
  };
  return res;
}

describe("authorizeBearer", () => {
  beforeEach(() => {
    delete process.env.PLYNE_DAEMON_API_TOKEN;
  });

  it("returns 503 when PLYNE_DAEMON_API_TOKEN is missing", () => {
    const res = fakeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = authorizeBearer(fakeReq("Bearer x") as any, res as any);
    assert.equal(ok, false);
    assert.equal(res.statusCode, 503);
  });

  it("returns 401 when Authorization header is missing", () => {
    process.env.PLYNE_DAEMON_API_TOKEN = "secret";
    const res = fakeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = authorizeBearer(fakeReq() as any, res as any);
    assert.equal(ok, false);
    assert.equal(res.statusCode, 401);
  });

  it("returns 401 on wrong bearer", () => {
    process.env.PLYNE_DAEMON_API_TOKEN = "secret";
    const res = fakeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = authorizeBearer(fakeReq("Bearer wrong") as any, res as any);
    assert.equal(ok, false);
    assert.equal(res.statusCode, 401);
  });

  it("accepts the configured bearer", () => {
    process.env.PLYNE_DAEMON_API_TOKEN = "secret";
    const res = fakeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = authorizeBearer(fakeReq("Bearer secret") as any, res as any);
    assert.equal(ok, true);
    assert.equal(res.statusCode, undefined);
  });

  it("is case-insensitive on the Bearer scheme", () => {
    process.env.PLYNE_DAEMON_API_TOKEN = "secret";
    const res = fakeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = authorizeBearer(fakeReq("bearer secret") as any, res as any);
    assert.equal(ok, true);
  });
});

describe("SSE framing", () => {
  it("serializeActivityFrame wraps the payload as a single event", () => {
    const frame = serializeActivityFrame({
      ts: "2026-06-02T10:00:00Z",
      event_type: "task.picked",
      task_id: "abc",
      task_name: "wire SSE",
      task_repo: "plyne-v3",
      details: { x: 1 }
    });
    assert.match(frame, /^event: activity\n/);
    assert.match(frame, /\ndata: \{.*"task_id":"abc".*\}\n\n$/);
    // exactly one blank line at the end (= terminator)
    assert.equal(frame.endsWith("\n\n"), true);
    // no embedded newlines inside the JSON line (would break SSE framing)
    const dataLine = frame.split("\n")[1] ?? "";
    assert.equal(dataLine.includes("\n"), false);
  });

  it("serializePingFrame emits a well-formed ping", () => {
    const frame = serializePingFrame();
    assert.equal(frame, "event: ping\ndata: {}\n\n");
  });
});
