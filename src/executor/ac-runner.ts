/**
 * AC runner — machine-verify a task's Acceptance Criteria in the worktree
 * BEFORE Plyne v3 opens the PR.
 *
 * Design contract (Plyne v3 stays thin, but auto-merge must be SAFE):
 *   - The Notion "Acceptance Criteria" field is free-text: a mix of
 *     machine-checkable lines `run: <shell command> expect_exit: <N>` and
 *     descriptive prose. Prose lines are Claude's responsibility (verified by
 *     its code-reviewer sub-agent), NOT machine-checkable here — we ignore
 *     them.
 *   - We extract every `run: ... expect_exit: N` line, run each command in the
 *     SAME cwd/env the executor used, and compare exit codes.
 *   - 0 executable lines  → "no machine-checkable AC" (warn, proceed).
 *   - all pass            → proceed to PR.
 *   - any fail            → block: runner sets needs-operator, no PR.
 *
 * Best-effort: a bug in the AC runner itself must NEVER crash the daemon. The
 * runner treats an internal error as "couldn't verify" and falls back to
 * today's behaviour (open the PR) while logging — see runner.ts.
 */
import { spawnSync } from "node:child_process";
import { logger } from "../config/logger.js";

export interface AcCheck {
  /** The raw shell command to execute. */
  command: string;
  /** The exit code the operator declared as "pass". */
  expectedExit: number;
}

export interface AcCheckResult extends AcCheck {
  /** Actual exit code observed (or -1 when the spawn itself failed). */
  actualExit: number;
  pass: boolean;
  /** Populated when the spawn could not run at all (e.g. ENOENT on the shell). */
  spawnError?: string;
}

export interface AcRunOutcome {
  /** "pass" — all executable AC passed (or none existed → vacuously safe). */
  status: "pass" | "fail" | "none";
  checks: AcCheckResult[];
  /** True when there were zero machine-checkable AC lines. */
  noExecutable: boolean;
}

/**
 * Parse free-text AC into the list of machine-checkable commands.
 *
 * Matches lines of the form:
 *   run: <command> expect_exit: <N>
 * The command is everything between `run:` and `expect_exit:` (trimmed). This
 * also captures `grep ... expect_exit: 0` style lines because `grep ...` is
 * just a command. Prose lines (no `run:`/`expect_exit:`) are ignored.
 *
 * The match is per-line and case-insensitive on the `run:`/`expect_exit:`
 * keywords so operators can write `RUN:`/`Expect_Exit:` without surprise.
 */
export function parseAcceptanceCriteria(ac: string): AcCheck[] {
  if (!ac) return [];
  const checks: AcCheck[] = [];
  // Per-line: anchor to avoid a greedy command swallowing a later expect_exit
  // on a different line. `.+?` (non-greedy) stops at the first expect_exit.
  const lineRe = /run:\s*(.+?)\s*expect_exit:\s*(\d+)/i;
  for (const rawLine of ac.split(/\r?\n/)) {
    const m = rawLine.match(lineRe);
    if (!m) continue;
    const command = (m[1] ?? "").trim();
    const expectedExit = Number.parseInt(m[2] ?? "", 10);
    if (!command || Number.isNaN(expectedExit)) continue;
    checks.push({ command, expectedExit });
  }
  return checks;
}

/**
 * Run a single AC command in `cwd` with `env`, returning the comparison.
 * Uses the shell so operators can write pipes / `grep ... | ...` freely.
 */
function runOne(check: AcCheck, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): AcCheckResult {
  try {
    const res = spawnSync(check.command, {
      cwd,
      env,
      shell: true,
      timeout: timeoutMs,
      encoding: "utf8"
    });
    // spawnSync sets .error on spawn failure (ENOENT, timeout kills via signal).
    if (res.error) {
      return {
        ...check,
        actualExit: -1,
        pass: false,
        spawnError: String(res.error).slice(0, 300)
      };
    }
    // On timeout the process is killed by signal; status is null. Treat as fail.
    const actualExit = typeof res.status === "number" ? res.status : -1;
    return { ...check, actualExit, pass: actualExit === check.expectedExit };
  } catch (err) {
    return {
      ...check,
      actualExit: -1,
      pass: false,
      spawnError: String(err).slice(0, 300)
    };
  }
}

/**
 * Decide pass/fail/none from a fully-populated check list. Pure function so it
 * can be unit-tested without spawning anything.
 */
export function decideAcOutcome(checks: AcCheckResult[]): AcRunOutcome {
  if (checks.length === 0) {
    return { status: "none", checks: [], noExecutable: true };
  }
  const allPass = checks.every((c) => c.pass);
  return { status: allPass ? "pass" : "fail", checks, noExecutable: false };
}

/**
 * Parse + run every machine-checkable AC line in the worktree.
 *
 * @param ac       free-text Acceptance Criteria
 * @param cwd      worktree dir the executor used
 * @param env      child env the executor used (token-bearing — same as Claude)
 * @param timeoutMs per-command timeout (default 2min — AC are quick checks)
 */
export function runAcceptanceCriteria(
  ac: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 120_000
): AcRunOutcome {
  const parsed = parseAcceptanceCriteria(ac);
  if (parsed.length === 0) {
    logger.warn(
      { cwd },
      "ac-runner: no machine-checkable AC (run:/expect_exit:) found — proceeding without verification. " +
        "Write executable AC for safe auto-merge."
    );
    return { status: "none", checks: [], noExecutable: true };
  }
  const results: AcCheckResult[] = parsed.map((c) => {
    const r = runOne(c, cwd, env, timeoutMs);
    logger.info(
      { command: r.command, expectedExit: r.expectedExit, actualExit: r.actualExit, pass: r.pass },
      "ac-runner: ran AC command"
    );
    return r;
  });
  return decideAcOutcome(results);
}

/** Render an AC outcome as a Markdown "## AC results" section for the PR body. */
export function renderAcResultsMarkdown(outcome: AcRunOutcome): string {
  if (outcome.noExecutable) {
    return [
      "## AC results",
      "",
      "_No machine-checkable AC (`run: ... expect_exit: N`) found — not verified by Plyne v3._"
    ].join("\n");
  }
  const lines = ["## AC results", ""];
  for (const c of outcome.checks) {
    const mark = c.pass ? "PASS" : "FAIL";
    const detail = c.spawnError
      ? ` (error: ${c.spawnError})`
      : ` (expected exit ${c.expectedExit}, got ${c.actualExit})`;
    lines.push(`- ${mark} \`${c.command}\`${detail}`);
  }
  return lines.join("\n");
}
