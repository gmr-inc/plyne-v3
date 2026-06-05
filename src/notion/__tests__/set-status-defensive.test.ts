/**
 * setStatus defensive-fallback tests.
 *
 * Closes the 2026-06 incident where a MISSING `needs-operator` status option on
 * the Notion board stranded tasks (the update threw, the task never moved). The
 * runner now walks an escalation fallback chain and still writes the
 * `CTO Feedback` reason regardless of which status finally sticks.
 *
 * Run locally: node --import tsx --test src/notion/__tests__/set-status-defensive.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setStatus, CTO_FEEDBACK_PROP, __test } from "../client.js";

interface Update {
  status: string;
  hasReason: boolean;
  reasonText: string | null;
}

/** Build a stub pages.update that fails for the given status option names and/or
 *  the CTO Feedback property, recording every attempt. */
function stub(opts: { missingStatuses?: string[]; missingProperty?: boolean } = {}) {
  const calls: Update[] = [];
  const missing = new Set(opts.missingStatuses ?? []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  __test.injectPagesUpdate(async (args: any) => {
    const props = args.properties ?? {};
    const status = props.Status?.status?.name as string;
    const reasonProp = props[CTO_FEEDBACK_PROP];
    const hasReason = Boolean(reasonProp);
    calls.push({
      status,
      hasReason,
      reasonText: hasReason ? reasonProp.rich_text[0].text.content : null
    });
    if (opts.missingProperty && hasReason) {
      throw { code: "validation_error", message: "CTO Feedback is not a property that exists" };
    }
    if (missing.has(status)) {
      throw { code: "validation_error", message: `${status} is not a valid option` };
    }
    return { id: "page" };
  });
  return calls;
}

afterEach(() => __test.reset());

describe("setStatus defensive fallback", () => {
  it("writes the requested status + the CTO Feedback reason on the happy path", async () => {
    const calls = stub();
    await setStatus("p1", "needs-revision", { reason: "PLYNE ESCALATION\nattempted: x" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.status, "needs-revision");
    assert.equal(calls[0]!.hasReason, true);
    assert.match(calls[0]!.reasonText!, /PLYNE ESCALATION/);
  });

  it("falls back through the chain when a status option is missing, STILL writing the reason", async () => {
    // needs-revision and needs-rework absent on the board → must land on needs-operator.
    const calls = stub({ missingStatuses: ["needs-revision", "needs-rework"] });
    await setStatus("p2", "needs-revision", { reason: "why a human is needed" });
    const landed = calls.at(-1)!;
    assert.equal(landed.status, "needs-operator");
    assert.equal(landed.hasReason, true, "reason persisted on the fallback status too");
    assert.equal(landed.reasonText, "why a human is needed");
  });

  it("never throws on a missing status — a missing status must not strand a task", async () => {
    // Even needs-operator (the last resort) succeeds in this stub.
    const calls = stub({ missingStatuses: ["needs-operator"] });
    // needs-operator is the only candidate in its own chain AND it's missing →
    // last-resort throw is acceptable, but for needs-rework the chain saves it.
    await assert.doesNotReject(setStatus("p3", "needs-rework", { reason: "r" }));
    assert.equal(calls.at(-1)!.status, "needs-rework");
  });

  it("drops only the reason (keeps the status) when the CTO Feedback PROPERTY is missing", async () => {
    const calls = stub({ missingProperty: true });
    await setStatus("p4", "needs-operator", { reason: "would-be reason" });
    // First attempt with the reason throws property-missing; retry without it succeeds.
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.hasReason, true);
    assert.equal(calls[1]!.hasReason, false);
    assert.equal(calls[1]!.status, "needs-operator");
  });

  it("still supports the legacy string prUrl signature", async () => {
    const calls = stub();
    await setStatus("p5", "pr-open", "https://github.com/x/y/pull/1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.status, "pr-open");
    assert.equal(calls[0]!.hasReason, false);
  });

  it("re-escalation overwrites (does not append) — idempotent reason field", async () => {
    const calls = stub();
    await setStatus("p6", "needs-revision", { reason: "first" });
    await setStatus("p6", "needs-revision", { reason: "second" });
    assert.equal(calls[0]!.reasonText, "first");
    assert.equal(calls[1]!.reasonText, "second");
    // Each write sends a single rich_text content, never an accumulation.
  });
});
