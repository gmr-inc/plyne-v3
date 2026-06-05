/**
 * escalation-reason tests — the structured, human-oriented reason the runner
 * persists onto a task's `CTO Feedback` field when it escalates to a human.
 *
 * Run locally: node --import tsx --test src/orchestrator/__tests__/escalation-reason.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatEscalationReason } from "../escalation-reason.js";

describe("formatEscalationReason", () => {
  it("captures the goal + outcome class for a simple blocker", () => {
    const out = formatEscalationReason({
      attempted: "Add a /health endpoint to the gateway",
      outcome: "hard_tech_blocker",
      keyError: "fatal: could not read from remote repository"
    });
    assert.match(out, /^PLYNE ESCALATION$/m);
    assert.match(out, /attempted: Add a \/health endpoint to the gateway/);
    assert.match(out, /outcome: hard_tech_blocker \(hard tech blocker\)/);
    assert.match(out, /error: fatal: could not read from remote repository/);
  });

  it("captures WHICH acceptance criteria failed — per-check expected-vs-actual", () => {
    const out = formatEscalationReason({
      attempted: "Make the build pass",
      outcome: "acceptance_criteria_failed",
      totalChecks: 3,
      failingChecks: [
        { command: "npm test", expectedExit: 0, actualExit: 1 },
        { command: "npm run build", expectedExit: 0, actualExit: -1, spawnError: "ENOENT: tsc not found" }
      ]
    });
    // N of M, not just a count
    assert.match(out, /ac: 2 of 3 failed/);
    // per-check expected-vs-actual
    assert.match(out, /- `npm test` expected exit 0, got 1/);
    // spawn errors surfaced distinctly
    assert.match(out, /- `npm run build` error: ENOENT: tsc not found/);
  });

  it("is deterministic — same input renders identically (idempotent overwrite)", () => {
    const reason = {
      attempted: "x",
      outcome: "acceptance_criteria_failed" as const,
      totalChecks: 1,
      failingChecks: [{ command: "a", expectedExit: 0, actualExit: 2 }]
    };
    assert.equal(formatEscalationReason(reason), formatEscalationReason(reason));
  });

  it("collapses whitespace and clips pathological log lines", () => {
    const out = formatEscalationReason({
      attempted: "y",
      outcome: "runner_exception",
      keyError: "line one\n   line two   \t" + "z".repeat(1000)
    });
    // newlines in the embedded error are flattened so the field stays line-oriented
    const errLine = out.split("\n").find((l) => l.startsWith("error:"));
    assert.ok(errLine, "has an error line");
    assert.ok(!errLine!.includes("\n"));
    assert.ok(errLine!.length < 320, "clipped");
    assert.match(out, /…$/);
  });

  it("omits the ac section when there are no failing checks", () => {
    const out = formatEscalationReason({ attempted: "y", outcome: "no_pr_produced" });
    assert.doesNotMatch(out, /ac:/);
    assert.match(out, /outcome: no_pr_produced \(no PR produced\)/);
  });
});
