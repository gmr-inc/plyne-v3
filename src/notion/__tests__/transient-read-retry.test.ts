/**
 * INF-127/128/129 — transient Notion reads are one transport wobble, not three
 * product failures. Read-only queries retry in-process; auth/contract errors do
 * not, and an outage still surfaces after the bounded third attempt.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  __test,
  isTransientNotionReadError,
  listReadyTasks
} from "../client.js";

afterEach(() => __test.reset());

function withoutWaiting(): void {
  __test.injectRetrySleep(async () => undefined);
}

describe("transient Notion database reads", () => {
  it("retries a gateway 520 once and returns the real response", async () => {
    withoutWaiting();
    let calls = 0;
    __test.injectDatabasesQuery(async () => {
      calls += 1;
      if (calls === 1) throw { status: 520, code: "internal_server_error" };
      return { results: [] };
    });

    await assert.doesNotReject(listReadyTasks("V3-"));
    assert.equal(calls, 2);
  });

  it("retries Notion RequestTimeoutError and ECONNRESET", async () => {
    withoutWaiting();
    let calls = 0;
    __test.injectDatabasesQuery(async () => {
      calls += 1;
      if (calls === 1) throw { name: "RequestTimeoutError" };
      if (calls === 2) throw { code: "ECONNRESET" };
      return { results: [] };
    });

    await assert.doesNotReject(listReadyTasks("V3-"));
    assert.equal(calls, 3);
  });

  it("surfaces a continuing outage after exactly three attempts", async () => {
    withoutWaiting();
    let calls = 0;
    __test.injectDatabasesQuery(async () => {
      calls += 1;
      throw { code: "ECONNRESET" };
    });

    await assert.rejects(listReadyTasks("V3-"), (err: unknown) => {
      assert.equal((err as { code?: string }).code, "ECONNRESET");
      return true;
    });
    assert.equal(calls, 3);
  });

  it("does not retry authentication or validation failures", async () => {
    withoutWaiting();
    for (const failure of [
      { status: 401, code: "unauthorized" },
      { status: 400, code: "validation_error" }
    ]) {
      let calls = 0;
      __test.injectDatabasesQuery(async () => {
        calls += 1;
        throw failure;
      });
      await assert.rejects(listReadyTasks("V3-"));
      assert.equal(calls, 1);
    }
  });

  it("classifies the three production signatures, but not a 401", () => {
    assert.equal(isTransientNotionReadError({ status: 520 }), true);
    assert.equal(isTransientNotionReadError({ name: "RequestTimeoutError" }), true);
    assert.equal(isTransientNotionReadError({ code: "ECONNRESET" }), true);
    assert.equal(isTransientNotionReadError({ status: 401 }), false);
  });
});
