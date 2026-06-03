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

const CODERABBIT = "coderabbitai";

/** Does this status node belong to CodeRabbit (by app slug / context / creator)? */
function isCodeRabbitNode(n: StatusCheckNode): boolean {
  const haystacks = [
    n.checkSuite?.app?.slug,
    n.name,
    n.context,
    n.creator?.login
  ];
  return haystacks.some((h) => typeof h === "string" && h.toLowerCase().includes(CODERABBIT));
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
  const rollup = input.statusCheckRollup ?? [];

  // 1) Any failing check → RED → skip (human decides).
  for (const n of rollup) {
    if (classifyNode(n) === "fail") return "skip";
  }

  // 2) Mergeability. CONFLICTING / DIRTY → skip. UNKNOWN → wait (GitHub still
  //    computing). A non-CLEAN blocking state that isn't a hard conflict
  //    (BEHIND/UNSTABLE) → wait — give CI/branch a chance to settle.
  const mergeable = (input.mergeable ?? "").toUpperCase();
  const state = (input.mergeStateStatus ?? "").toUpperCase();
  if (mergeable === "CONFLICTING") return "skip";
  if (state === "DIRTY" || state === "DRAFT") return "skip";
  if (reviewIsBlocked(input)) return "skip";
  if (mergeable === "UNKNOWN" || mergeable === "") return "wait";

  // 3) CodeRabbit gate: there must be a CodeRabbit signal AND it must be
  //    success/approved. No CodeRabbit signal yet → WAIT (don't merge an
  //    unreviewed PR).
  const crNodes = rollup.filter(isCodeRabbitNode);
  const crReviews = (input.reviews ?? []).filter(
    (r) => typeof r.author?.login === "string" && r.author.login.toLowerCase().includes(CODERABBIT)
  );
  const crSeen = crNodes.length > 0 || crReviews.length > 0;
  if (!crSeen) return "wait";

  // Any CodeRabbit check still pending → wait.
  if (crNodes.some((n) => classifyNode(n) === "pending")) return "wait";
  // A CodeRabbit "CHANGES_REQUESTED" review → skip (human must resolve).
  if (crReviews.some((r) => (r.state ?? "").toUpperCase() === "CHANGES_REQUESTED")) return "skip";

  // 4) Any non-CodeRabbit check still pending → wait.
  for (const n of rollup) {
    if (isCodeRabbitNode(n)) continue;
    if (classifyNode(n) === "pending") return "wait";
  }

  // 5) State must be CLEAN (or UNSTABLE collapses to wait above). Only merge on
  //    a fully clean mergeable PR.
  if (mergeable === "MERGEABLE" && (state === "CLEAN" || state === "HAS_HOOKS")) {
    return "merge";
  }
  // Anything else (BLOCKED, BEHIND, UNSTABLE, UNKNOWN state) → wait.
  return "wait";
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
