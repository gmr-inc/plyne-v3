/**
 * Structured, human-oriented escalation reason.
 *
 * The gap this closes (from prod logs): when the runner withholds a PR and
 * escalates a task to a human (`needs-operator` / `needs-rework` /
 * `needs-revision`), it logged the reason locally but left the Notion task's
 * `CTO Feedback` field EMPTY — so the console's LLM layer had nothing to turn
 * into plain language ("why does a human need to look at this?").
 *
 * This module produces a COMPACT, MACHINE-READABLE-BUT-HUMAN-TRANSLATABLE
 * reason. It is NOT a wall of raw logs: it captures the few facts the console
 * needs to explain the escalation —
 *   - what the agent ATTEMPTED (the task goal, 1 line),
 *   - the OUTCOME class (acceptance criteria failed / hard tech blocker / …),
 *   - WHICH acceptance criteria failed (per-check expected-vs-actual),
 *   - the key error/log line, if relevant.
 *
 * The rendered string is deterministic (so re-escalation overwrites the same
 * field idempotently) and small enough to live in a Notion rich_text property.
 */

/** The coarse outcome class — the console keys plain-language copy off this. */
export type EscalationOutcome =
  | "acceptance_criteria_failed"
  | "self_blocked"
  | "hard_tech_blocker"
  | "no_pr_produced"
  | "runner_exception";

/** One failing acceptance-criterion, captured with expected-vs-actual. */
export interface FailingCheckDetail {
  /** The shell command the AC declared. */
  command: string;
  /** Exit code the AC declared as "pass". */
  expectedExit: number;
  /** Exit code actually observed (-1 when the spawn itself failed). */
  actualExit: number;
  /** Set when the command could not be spawned at all (ENOENT, timeout…). */
  spawnError?: string | undefined;
}

export interface EscalationReason {
  /** 1-line statement of what the agent set out to do (the task goal). */
  attempted: string;
  /** Coarse outcome class — drives the console's plain-language template. */
  outcome: EscalationOutcome;
  /** Per-check detail for AC failures (the specific checks, not just a count). */
  failingChecks?: FailingCheckDetail[] | undefined;
  /** total executable AC checks (so "N of M failed" can be shown). */
  totalChecks?: number | undefined;
  /** The single key error/log line, if relevant. NOT a log dump. */
  keyError?: string | undefined;
}

/** Cap any single embedded string so a pathological log line can't blow the field. */
function clip(s: string, max = 280): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const OUTCOME_LABEL: Record<EscalationOutcome, string> = {
  acceptance_criteria_failed: "acceptance criteria failed",
  self_blocked: "agent self-blocked",
  hard_tech_blocker: "hard tech blocker",
  no_pr_produced: "no PR produced",
  runner_exception: "runner exception"
};

/**
 * Render an EscalationReason into a compact, structured text block for the
 * `CTO Feedback` Notion field. Deterministic → re-escalation overwrites the
 * same content (idempotent, never appends).
 *
 * Shape (stable, line-oriented so an LLM can parse it trivially):
 *   PLYNE ESCALATION
 *   attempted: <goal>
 *   outcome: <class> (<human label>)
 *   ac: 2 of 3 failed
 *     - `npm test` expected exit 0, got 1
 *     - `npm run build` error: ENOENT
 *   error: <key line>
 */
export function formatEscalationReason(r: EscalationReason): string {
  const lines: string[] = [
    "PLYNE ESCALATION",
    `attempted: ${clip(r.attempted || "(no task goal on record)")}`,
    `outcome: ${r.outcome} (${OUTCOME_LABEL[r.outcome]})`
  ];

  const failing = r.failingChecks ?? [];
  if (failing.length > 0) {
    const total = r.totalChecks ?? failing.length;
    lines.push(`ac: ${failing.length} of ${total} failed`);
    for (const c of failing) {
      const detail = c.spawnError
        ? `error: ${clip(c.spawnError, 160)}`
        : `expected exit ${c.expectedExit}, got ${c.actualExit}`;
      lines.push(`  - \`${clip(c.command, 160)}\` ${detail}`);
    }
  }

  if (r.keyError) {
    lines.push(`error: ${clip(r.keyError)}`);
  }

  return lines.join("\n");
}
