/**
 * ac-runner tests — the AC parser + pass/fail decision. Pure functions, no
 * spawning, run under node --test.
 *
 * Run locally: node --import tsx --test src/executor/__tests__/ac-runner.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAcceptanceCriteria,
  decideAcOutcome,
  renderAcResultsMarkdown,
  type AcCheckResult
} from "../ac-runner.js";

describe("parseAcceptanceCriteria", () => {
  it("extracts run:/expect_exit pairs", () => {
    const ac = "run: npm test expect_exit: 0";
    assert.deepEqual(parseAcceptanceCriteria(ac), [{ command: "npm test", expectedExit: 0 }]);
  });

  it("extracts multiple lines and trims the command", () => {
    const ac = ["run:   npm run build   expect_exit: 0", "run: grep -q foo src/x.ts expect_exit: 0"].join("\n");
    assert.deepEqual(parseAcceptanceCriteria(ac), [
      { command: "npm run build", expectedExit: 0 },
      { command: "grep -q foo src/x.ts", expectedExit: 0 }
    ]);
  });

  it("ignores prose lines (no run:/expect_exit:)", () => {
    const ac = [
      "The UI must look polished and accessible.",
      "run: npm test expect_exit: 0",
      "Code should be well documented.",
      "run: test -f dist/index.js expect_exit: 0"
    ].join("\n");
    assert.deepEqual(parseAcceptanceCriteria(ac), [
      { command: "npm test", expectedExit: 0 },
      { command: "test -f dist/index.js", expectedExit: 0 }
    ]);
  });

  it("supports non-zero expected exit codes", () => {
    const ac = "run: grep -q nope file.txt expect_exit: 1";
    assert.deepEqual(parseAcceptanceCriteria(ac), [{ command: "grep -q nope file.txt", expectedExit: 1 }]);
  });

  it("is case-insensitive on the keywords", () => {
    const ac = "RUN: npm test EXPECT_EXIT: 0";
    assert.deepEqual(parseAcceptanceCriteria(ac), [{ command: "npm test", expectedExit: 0 }]);
  });

  it("returns [] for empty / prose-only AC", () => {
    assert.deepEqual(parseAcceptanceCriteria(""), []);
    assert.deepEqual(parseAcceptanceCriteria("Just make it good."), []);
  });

  it("does not let a command greedily swallow a later line's expect_exit", () => {
    // Non-greedy: first expect_exit on the SAME line ends the command.
    const ac = "run: echo a expect_exit: 0 and some trailing prose expect_exit: 9";
    assert.deepEqual(parseAcceptanceCriteria(ac), [{ command: "echo a", expectedExit: 0 }]);
  });
});

function result(over: Partial<AcCheckResult>): AcCheckResult {
  return { command: "x", expectedExit: 0, actualExit: 0, pass: true, ...over };
}

describe("decideAcOutcome", () => {
  it("reports 'none' when there are no checks", () => {
    const o = decideAcOutcome([]);
    assert.equal(o.status, "none");
    assert.equal(o.noExecutable, true);
  });

  it("reports 'pass' when every check passed", () => {
    const o = decideAcOutcome([result({ pass: true }), result({ pass: true })]);
    assert.equal(o.status, "pass");
    assert.equal(o.noExecutable, false);
  });

  it("reports 'fail' when any check failed", () => {
    const o = decideAcOutcome([result({ pass: true }), result({ pass: false, actualExit: 1, expectedExit: 0 })]);
    assert.equal(o.status, "fail");
  });
});

describe("renderAcResultsMarkdown", () => {
  it("notes when there are no machine-checkable AC", () => {
    const md = renderAcResultsMarkdown({ status: "none", checks: [], noExecutable: true });
    assert.match(md, /## AC results/);
    assert.match(md, /No machine-checkable AC/);
  });

  it("renders PASS/FAIL per command with expected/actual", () => {
    const md = renderAcResultsMarkdown({
      status: "fail",
      noExecutable: false,
      checks: [
        result({ command: "npm test", pass: true }),
        result({ command: "npm run build", pass: false, actualExit: 2, expectedExit: 0 })
      ]
    });
    assert.match(md, /PASS `npm test`/);
    assert.match(md, /FAIL `npm run build`.*expected exit 0, got 2/);
  });
});
