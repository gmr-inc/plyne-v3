/**
 * merge-gate — pure decision logic for "is this PR safe to auto-merge?".
 *
 * Separated from the GitHub I/O (auto-merge-loop.ts) so the gate can be
 * unit-tested with no network. The loop fetches `gh pr view ... --json
 * mergeable,mergeStateStatus,reviewDecision,statusCheckRollup` and feeds the
 * parsed JSON here.
 *
 * The gate (Part 1 already verified the AC before the PR existed, so by
 * pr-open the AC passed — the merge gate is therefore CI + CodeRabbit only):
 *   - every required status check / CI rollup entry = SUCCESS
 *     (any pending/queued/in-progress → WAIT; any failure → RED);
 *   - CodeRabbit (a check or review whose actor/app login contains
 *     `coderabbitai`) is success/approved — if CodeRabbit hasn't weighed in
 *     yet → WAIT (never merge an unreviewed PR);
 *   - PR mergeable === "MERGEABLE" and mergeStateStatus is CLEAN-ish.
 *
 * Three outcomes:
 *   - "merge" → all green, go.
 *   - "wait"  → not red, but something still pending (checks running,
 *               CodeRabbit not in yet, mergeable UNKNOWN). Re-poll later.
 *   - "skip"  → red / failed / blocked. Leave for the human, do NOT merge.
 */

export type MergeDecision = "merge" | "wait" | "skip";

/** A decision plus a human-readable reason, so the loop can log WHY it held. */
export interface MergeDecisionDetail {
  decision: MergeDecision;
  reason: string;
}

export interface StatusCheckNode {
  // GitHub returns a heterogeneous union: CheckRun (__typename CheckRun) and
  // StatusContext (__typename StatusContext). We read the fields each exposes.
  __typename?: string;
  // CheckRun
  name?: string | null;
  status?: string | null; // QUEUED | IN_PROGRESS | COMPLETED
  conclusion?: string | null; // SUCCESS | FAILURE | NEUTRAL | CANCELLED | SKIPPED | ...
  // CheckRun actor / app
  checkSuite?: { app?: { slug?: string | null } | null } | null;
  // StatusContext
  context?: string | null;
  state?: string | null; // SUCCESS | PENDING | FAILURE | ERROR | EXPECTED
  // StatusContext creator
  creator?: { login?: string | null } | null;
}

export interface PrReviewNode {
  state?: string | null; // APPROVED | CHANGES_REQUESTED | COMMENTED | ...
  author?: { login?: string | null } | null;
}

export interface PrGateInput {
  mergeable?: string | null; // MERGEABLE | CONFLICTING | UNKNOWN
  mergeStateStatus?: string | null; // CLEAN | BLOCKED | BEHIND | DIRTY | UNSTABLE | HAS_HOOKS | DRAFT | UNKNOWN
  reviewDecision?: string | null; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
  statusCheckRollup?: StatusCheckNode[] | null;
  reviews?: PrReviewNode[] | null;
}

// CodeRabbit identifies itself inconsistently across surfaces:
//   - as a *commit status* (StatusContext) with context "CodeRabbit" and a
//     null creator  ← this is how it reports on THIS repo;
//   - as a *check-run* whose checkSuite.app.slug is "coderabbitai";
//   - as a *PR review* whose author login is "coderabbitai[bot]".
// Matching only the full "coderabbitai" slug MISSES the bare "CodeRabbit"
// status context (it has no "ai" suffix), so we match the "coderabbit" stem.
const CODERABBIT = "coderabbit";

function looksLikeCodeRabbit(s: string | null | undefined): boolean {
  return typeof s === "string" && s.toLowerCase().includes(CODERABBIT);
}

/** Does this status node belong to CodeRabbit (by app slug / context / creator)? */
function isCodeRabbitNode(n: StatusCheckNode): boolean {
  return (
    looksLikeCodeRabbit(n.checkSuite?.app?.slug) ||
    looksLikeCodeRabbit(n.name) ||
    looksLikeCodeRabbit(n.context) ||
    looksLikeCodeRabbit(n.creator?.login)
  );
}

/** Normalize a single status node to pass | fail | pending. */
function classifyNode(n: StatusCheckNode): "pass" | "fail" | "pending" {
  // CheckRun path.
  if (n.status !== undefined || n.conclusion !== undefined) {
    if (n.status && n.status !== "COMPLETED") return "pending";
    const c = (n.conclusion ?? "").toUpperCase();
    if (c === "SUCCESS" || c === "NEUTRAL" || c === "SKIPPED") return "pass";
    if (c === "" || c === "ACTION_REQUIRED") return "pending";
    // FAILURE | CANCELLED | TIMED_OUT | STARTUP_FAILURE | STALE
    return "fail";
  }
  // StatusContext path.
  const s = (n.state ?? "").toUpperCase();
  if (s === "SUCCESS") return "pass";
  if (s === "PENDING" || s === "EXPECTED" || s === "") return "pending";
  // FAILURE | ERROR
  return "fail";
}

/**
 * Decide whether the PR is safe to auto-merge from its GitHub JSON.
 */
export function decideMerge(input: PrGateInput): MergeDecision {
  return decideMergeWithReason(input).decision;
}

/**
 * Same decision as {@link decideMerge}, but also returns a precise reason so
 * the auto-merge loop can log WHY it held (e.g. "holding: CI check `lint`
 * pending" vs "holding: CodeRabbit has not reviewed yet").
 */
export function decideMergeWithReason(input: PrGateInput): MergeDecisionDetail {
  const rollup = input.statusCheckRollup ?? [];

  // 1) Any failing check → RED → skip (human decides).
  for (const n of rollup) {
    if (classifyNode(n) === "fail") {
      return { decision: "skip", reason: `CI check \`${nodeLabel(n)}\` failed` };
    }
  }

  // 2) Mergeability. CONFLICTING / DIRTY → skip. UNKNOWN → wait (GitHub still
  //    computing). A non-CLEAN blocking state that isn't a hard conflict
  //    (BEHIND/UNSTABLE) → wait — give CI/branch a chance to settle.
  const mergeable = (input.mergeable ?? "").toUpperCase();
  const state = (input.mergeStateStatus ?? "").toUpperCase();
  if (mergeable === "CONFLICTING") return { decision: "skip", reason: "PR has merge conflicts (mergeable=CONFLICTING)" };
  if (state === "DIRTY") return { decision: "skip", reason: "mergeStateStatus=DIRTY (conflicts)" };
  if (state === "DRAFT") return { decision: "skip", reason: "PR is a draft" };
  if (reviewIsBlocked(input)) return { decision: "skip", reason: "reviewDecision=CHANGES_REQUESTED" };
  if (mergeable === "UNKNOWN" || mergeable === "") {
    return { decision: "wait", reason: "mergeable=UNKNOWN — GitHub still computing mergeability" };
  }

  // 3) CodeRabbit gate: there must be a CodeRabbit signal AND it must be
  //    success/approved. No CodeRabbit signal yet → WAIT (don't merge an
  //    unreviewed PR). On THIS repo CodeRabbit reports as a StatusContext
  //    (context="CodeRabbit"); on others as a check-run or a PR review.
  const crNodes = rollup.filter(isCodeRabbitNode);
  const crReviews = (input.reviews ?? []).filter((r) => looksLikeCodeRabbit(r.author?.login));
  const crSeen = crNodes.length > 0 || crReviews.length > 0;
  if (!crSeen) {
    return { decision: "wait", reason: "CodeRabbit has not reviewed yet (no CodeRabbit check or review present)" };
  }

  // Any CodeRabbit check still pending → wait.
  if (crNodes.some((n) => classifyNode(n) === "pending")) {
    return { decision: "wait", reason: "CodeRabbit signal still pending/in-progress" };
  }
  // A CodeRabbit "CHANGES_REQUESTED" review → skip (human must resolve).
  if (crReviews.some((r) => (r.state ?? "").toUpperCase() === "CHANGES_REQUESTED")) {
    return { decision: "skip", reason: "CodeRabbit requested changes" };
  }

  // 4) Any non-CodeRabbit check still pending → wait.
  for (const n of rollup) {
    if (isCodeRabbitNode(n)) continue;
    if (classifyNode(n) === "pending") {
      return { decision: "wait", reason: `CI check \`${nodeLabel(n)}\` pending` };
    }
  }

  // 5) State gate. We've already proven every rollup entry is pass (no fail in
  //    step 1, no pending in steps 3-4) and CodeRabbit is green. So:
  //      - CLEAN / HAS_HOOKS → merge.
  //      - UNSTABLE → merge: by definition some check is non-SUCCESS, but every
  //        check we can see in the rollup passed, so the "unstable" signal is a
  //        non-required check (e.g. an optional/informational status). The
  //        branch-protection required set is satisfied (else state would be
  //        BLOCKED), so it's safe to squash-merge.
  if (mergeable === "MERGEABLE" && (state === "CLEAN" || state === "HAS_HOOKS")) {
    return { decision: "merge", reason: "all required CI checks SUCCESS + CodeRabbit green + mergeable CLEAN" };
  }
  if (mergeable === "MERGEABLE" && state === "UNSTABLE") {
    return {
      decision: "merge",
      reason: "all visible checks SUCCESS + CodeRabbit green + mergeable; UNSTABLE is a non-required check"
    };
  }
  // Anything else (BLOCKED, BEHIND, UNKNOWN state) → wait.
  return { decision: "wait", reason: `mergeStateStatus=${state || "(empty)"} not yet mergeable` };
}

/** Best-effort human label for a status node (check name or status context). */
function nodeLabel(n: StatusCheckNode): string {
  return n.name || n.context || "(unnamed check)";
}

/**
 * reviewDecision === CHANGES_REQUESTED means a human/bot blocked the PR →
 * skip. REVIEW_REQUIRED alone is fine here because CodeRabbit is handled
 * explicitly above and we don't want to require a *human* approval to merge a
 * pre-launch internal PR.
 */
function reviewIsBlocked(input: PrGateInput): boolean {
  return (input.reviewDecision ?? "").toUpperCase() === "CHANGES_REQUESTED";
}
