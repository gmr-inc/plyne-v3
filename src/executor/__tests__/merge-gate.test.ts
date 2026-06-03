/**
 * merge-gate tests — the pure green/red/wait decision, no network.
 *
 * Run locally: node --import tsx --test src/executor/__tests__/merge-gate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideMerge, type PrGateInput, type StatusCheckNode } from "../merge-gate.js";

function check(over: Partial<StatusCheckNode>): StatusCheckNode {
  return { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", ...over };
}

const codeRabbitOk: StatusCheckNode = {
  __typename: "CheckRun",
  name: "CodeRabbit",
  status: "COMPLETED",
  conclusion: "SUCCESS",
  checkSuite: { app: { slug: "coderabbitai" } }
};

function green(over: Partial<PrGateInput> = {}): PrGateInput {
  return {
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    statusCheckRollup: [check({}), codeRabbitOk],
    reviews: [],
    ...over
  };
}

describe("decideMerge", () => {
  it("merges a fully green PR (CI success + CodeRabbit success + CLEAN)", () => {
    assert.equal(decideMerge(green()), "merge");
  });

  it("skips when a CI check FAILED (red)", () => {
    const input = green({ statusCheckRollup: [check({ conclusion: "FAILURE" }), codeRabbitOk] });
    assert.equal(decideMerge(input), "skip");
  });

  it("skips when a StatusContext is in FAILURE state", () => {
    const input = green({
      statusCheckRollup: [{ __typename: "StatusContext", context: "build", state: "FAILURE" }, codeRabbitOk]
    });
    assert.equal(decideMerge(input), "skip");
  });

  it("waits when CodeRabbit has not reviewed yet (no coderabbit node/review)", () => {
    const input = green({ statusCheckRollup: [check({})] }); // only generic CI, no CodeRabbit
    assert.equal(decideMerge(input), "wait");
  });

  it("waits when CodeRabbit's check is still pending", () => {
    const crPending: StatusCheckNode = {
      __typename: "CheckRun",
      name: "CodeRabbit",
      status: "IN_PROGRESS",
      conclusion: null,
      checkSuite: { app: { slug: "coderabbitai" } }
    };
    const input = green({ statusCheckRollup: [check({}), crPending] });
    assert.equal(decideMerge(input), "wait");
  });

  it("waits when a non-CodeRabbit check is still pending", () => {
    const input = green({ statusCheckRollup: [check({ status: "IN_PROGRESS", conclusion: null }), codeRabbitOk] });
    assert.equal(decideMerge(input), "wait");
  });

  it("accepts CodeRabbit via a review (APPROVED) when there is no CR check", () => {
    const input = green({
      statusCheckRollup: [check({})],
      reviews: [{ state: "APPROVED", author: { login: "coderabbitai[bot]" } }]
    });
    assert.equal(decideMerge(input), "merge");
  });

  it("skips when CodeRabbit requested changes", () => {
    const input = green({
      statusCheckRollup: [check({})],
      reviews: [{ state: "CHANGES_REQUESTED", author: { login: "coderabbitai[bot]" } }]
    });
    assert.equal(decideMerge(input), "skip");
  });

  it("skips a conflicting PR", () => {
    assert.equal(decideMerge(green({ mergeable: "CONFLICTING" })), "skip");
  });

  it("skips a dirty/draft merge state", () => {
    assert.equal(decideMerge(green({ mergeStateStatus: "DIRTY" })), "skip");
    assert.equal(decideMerge(green({ mergeStateStatus: "DRAFT" })), "skip");
  });

  it("skips when reviewDecision is CHANGES_REQUESTED", () => {
    assert.equal(decideMerge(green({ reviewDecision: "CHANGES_REQUESTED" })), "skip");
  });

  it("waits when mergeable is UNKNOWN (GitHub still computing)", () => {
    assert.equal(decideMerge(green({ mergeable: "UNKNOWN" })), "wait");
  });

  it("waits when state is BLOCKED/BEHIND even if checks pass", () => {
    assert.equal(decideMerge(green({ mergeStateStatus: "BLOCKED" })), "wait");
    assert.equal(decideMerge(green({ mergeStateStatus: "BEHIND" })), "wait");
  });

  it("merges UNSTABLE when every visible check passed (UNSTABLE = non-required check)", () => {
    // mergeStateStatus=UNSTABLE means some non-required check isn't SUCCESS, but
    // every check we can see in the rollup passed and CodeRabbit is green.
    assert.equal(decideMerge(green({ mergeStateStatus: "UNSTABLE" })), "merge");
  });

  // --- Regression for the live #345 hang: CodeRabbit reports as a plain
  //     StatusContext (context "CodeRabbit", null creator), NOT a check-run
  //     with a "coderabbitai" app slug and NOT a PR review. The old
  //     substring match on "coderabbitai" missed the bare "CodeRabbit" context
  //     (no "ai"), so the gate waited forever on a fully green PR.
  it("merges when CodeRabbit reports as a StatusContext context='CodeRabbit' (live #345 shape)", () => {
    const input = green({
      reviewDecision: "", // CodeRabbit auto-review does NOT set formal reviewDecision
      reviews: [],
      statusCheckRollup: [{ __typename: "StatusContext", context: "CodeRabbit", state: "SUCCESS" }]
    });
    assert.equal(decideMerge(input), "merge");
  });

  it("waits when the CodeRabbit StatusContext is still PENDING", () => {
    const input = green({
      reviewDecision: "",
      reviews: [],
      statusCheckRollup: [{ __typename: "StatusContext", context: "CodeRabbit", state: "PENDING" }]
    });
    assert.equal(decideMerge(input), "wait");
  });

  it("treats NEUTRAL/SKIPPED conclusions as pass", () => {
    const input = green({
      statusCheckRollup: [check({ conclusion: "NEUTRAL" }), check({ conclusion: "SKIPPED" }), codeRabbitOk]
    });
    assert.equal(decideMerge(input), "merge");
  });
});
