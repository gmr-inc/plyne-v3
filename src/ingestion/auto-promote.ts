/**
 * Auto-promotion policy — the detection→fix gap closer.
 *
 * BACKGROUND. Ingestion files real bugs into Notion `backlog` (see
 * task-creator.ts). The runner (orchestrator/runner.ts → notion listReadyTasks)
 * only claims tasks that are BOTH `ready` AND whose external_id starts with the
 * runner prefix (PLYNE_V3_TASK_PREFIX, default `V3-TEST-`). So an
 * ingestion-created task — status `backlog`, id `INGEST-…` — can NEVER be picked
 * up without an operator manually (a) promoting it to `ready` and (b) renaming
 * it to a runner-visible prefix. That manual step is why the loop has never
 * closed end-to-end on a real bug.
 *
 * This module is the missing automation. It applies a STRICT, layered policy
 * and — only when the operator has explicitly enabled it — promotes a
 * qualifying task toward execution.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SAFETY POSTURE (read before touching this file)
 *
 *   • PLYNE_AUTO_PROMOTE default OFF. When off, `autoPromote()` runs the policy
 *     and LOGS the decision (dry-run) but performs NO Notion writes. This is the
 *     observe-only mode used to validate the policy against live traffic.
 *
 *   • Even when ON, this only takes a task to `ready`. The runner then opens a
 *     PR. The PR is NEVER auto-merged for an autonomously-detected fix unless
 *     PLYNE_AUTO_PROMOTE_AUTOMERGE is ALSO true — a deliberate second gate so a
 *     human reviews the merge of any fix Plyne both found AND wrote.
 *
 *   • Fail-closed repo allowlist: an empty allowlist promotes NOTHING. The
 *     human opts each real repo in by name.
 *
 *   • Rate limit + operator-backlog circuit breaker bound the blast radius of a
 *     signal storm.
 *
 * The policy fn is PURE (no I/O) so it can be exhaustively unit-tested. The
 * side-effecting `autoPromote()` is a thin wrapper that consults the policy and
 * a process-local rate limiter, then (when live) flips Notion status + prefix.
 */
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import type { IngestSignal, Severity } from "./types.js";

/** A real monitoring source — demo/synthetic rows are never promoted. */
const REAL_SOURCES: ReadonlySet<string> = new Set([
  "sentry",
  "betterstack",
  "braintrust",
  "statuspage"
]);

/** Severity rank — higher is worse. Only P0/P1 are eligible. */
const SEVERITY_RANK: Record<Severity, number> = { P3: 0, P2: 1, P1: 2, P0: 3 };
const MIN_SEVERITY_RANK = SEVERITY_RANK.P1;

/**
 * Heuristic: is this signal synthetic/demo and therefore NEVER promotable,
 * regardless of source? The webhook seed + e2e smoke rows tag themselves with
 * `[demo]` / `synthetic` / `E2E` in the title; the migration uses
 * `signal_id_demo_*` ids. We refuse anything that looks like test data so a
 * stray smoke row can't trigger a real PR.
 */
export function looksSynthetic(signal: IngestSignal): boolean {
  const t = (signal.title || "").toLowerCase();
  const id = (signal.externalId || "").toLowerCase();
  return (
    t.includes("[demo]") ||
    t.includes("synthetic") ||
    t.includes("e2e evidence smoke") ||
    t.includes("e2e-smoke") ||
    id.startsWith("signal_id_demo") ||
    id.startsWith("demo-") ||
    id.includes("smoke")
  );
}

export interface PromotionContext {
  /** Repos auto-promote is allowed to target (org/name). Empty = none. */
  repoAllowlist: ReadonlySet<string>;
  /** The repo this signal's product maps to (from portfolio-map.lookupRepo). */
  repo: string;
  /** Minimum signal age (ms) before it may be promoted. 0 disables. */
  minAgeMs: number;
  /** Now, injectable for tests. */
  nowMs: number;
  /** Open operator backlog (needs-operator + ready). Circuit breaker input. */
  openBacklog: number;
  /** Promote only when openBacklog < this. 0 disables the breaker. */
  maxOpenBacklog: number;
  /** Whether the rate-limit window still has capacity. */
  rateLimitOk: boolean;
}

export type PromotionDecision =
  | { promote: true }
  | { promote: false; reason: string };

/**
 * PURE policy. Returns whether `signal` qualifies for promotion. Order matters
 * only for which reason surfaces first; every gate is independent.
 *
 * Gates:
 *   1. real source (not demo/synthetic vendor)
 *   2. not synthetic/demo by title/id heuristic
 *   3. not a vendor-outage signal (we don't open PRs against third-party infra)
 *   4. severity ≥ P1
 *   5. repo resolved AND in the fail-closed allowlist
 *   6. age ≥ minAgeMs (soak)
 *   7. operator backlog below the circuit-breaker threshold
 *   8. rate-limit window has capacity
 */
export function evaluatePromotion(
  signal: IngestSignal,
  ctx: PromotionContext
): PromotionDecision {
  if (!REAL_SOURCES.has(signal.source)) {
    return { promote: false, reason: `source_not_real:${signal.source}` };
  }
  if (looksSynthetic(signal)) {
    return { promote: false, reason: "synthetic_or_demo" };
  }
  if (signal.vendor === true) {
    return { promote: false, reason: "vendor_outage_not_fixable" };
  }
  if (SEVERITY_RANK[signal.severity] < MIN_SEVERITY_RANK) {
    return { promote: false, reason: `severity_below_p1:${signal.severity}` };
  }
  if (!ctx.repo) {
    return { promote: false, reason: "unknown_repo" };
  }
  if (!ctx.repoAllowlist.has(ctx.repo)) {
    return { promote: false, reason: `repo_not_allowlisted:${ctx.repo}` };
  }
  if (ctx.minAgeMs > 0 && signal.firstSeenAt) {
    const ageMs = ctx.nowMs - new Date(signal.firstSeenAt).getTime();
    if (Number.isFinite(ageMs) && ageMs < ctx.minAgeMs) {
      return { promote: false, reason: `too_fresh:${Math.max(0, Math.round(ageMs))}ms` };
    }
  }
  if (ctx.maxOpenBacklog > 0 && ctx.openBacklog >= ctx.maxOpenBacklog) {
    return {
      promote: false,
      reason: `operator_backlog_full:${ctx.openBacklog}>=${ctx.maxOpenBacklog}`
    };
  }
  if (!ctx.rateLimitOk) {
    return { promote: false, reason: "rate_limited" };
  }
  return { promote: true };
}

/**
 * Process-local sliding-window rate limiter. Records promotion timestamps and
 * answers "do we have capacity right now?" — bounded by maxPerWindow over
 * windowMs. Survives a daemon restart at worst as a fully-reset window (which
 * fails open by one window — acceptable; the operator-backlog breaker is the
 * durable backstop).
 */
export class PromotionRateLimiter {
  private readonly hits: number[] = [];
  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /** True if a promotion is allowed at this instant (does NOT consume). */
  hasCapacity(): boolean {
    this.prune();
    return this.hits.length < this.maxPerWindow;
  }

  /** Record that a promotion happened (consumes one slot). */
  record(): void {
    this.hits.push(this.now());
  }

  /** Current count in window — for logs/tests. */
  count(): number {
    this.prune();
    return this.hits.length;
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.hits.length > 0 && (this.hits[0] as number) < cutoff) this.hits.shift();
  }
}

/** Singleton limiter sized from env. */
let _limiter: PromotionRateLimiter | undefined;
function getLimiter(): PromotionRateLimiter {
  if (!_limiter) {
    const env = loadEnv();
    _limiter = new PromotionRateLimiter(
      env.PLYNE_AUTO_PROMOTE_MAX_PER_WINDOW,
      env.PLYNE_AUTO_PROMOTE_WINDOW_MS
    );
  }
  return _limiter;
}

/** Parse the comma-separated allowlist env into a Set. */
export function parseRepoAllowlist(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * Dependencies the side-effecting promoter needs — injected so the wiring is
 * testable without hitting Notion. In production these are bound to the real
 * notion client by the caller (task-creator).
 */
export interface PromoteDeps {
  /** Count tasks the operator must look at (needs-operator + ready). */
  countOpenBacklog: () => Promise<number>;
  /** Flip a Notion task to `ready` and rewrite its Name to the runner prefix. */
  promoteTask: (pageId: string, newExternalId: string) => Promise<void>;
}

export interface AutoPromoteInput {
  signal: IngestSignal;
  /** The just-created Notion page id (from createTaskFromSignal). */
  pageId: string;
  /** The task's current external_id (e.g. INGEST-SENTRY-…). */
  externalId: string;
  /** Repo the signal's product maps to. */
  repo: string;
}

export interface AutoPromoteResult {
  /** Did the policy say this qualifies? */
  qualified: boolean;
  /** Did we actually write (true only when live AND qualified)? */
  promoted: boolean;
  /** Dry-run (flag off) — policy ran, no write. */
  dryRun: boolean;
  reason: string;
  newExternalId?: string;
}

/**
 * Evaluate + (when live) perform promotion for one created task.
 *
 * BEST-EFFORT: never throws into the ingestion hot path. A failure here must
 * leave the task safely in `backlog` for the operator — the worst case is "no
 * automation", never "wrong automation".
 */
export async function autoPromote(
  input: AutoPromoteInput,
  deps: PromoteDeps
): Promise<AutoPromoteResult> {
  const env = loadEnv();
  const limiter = getLimiter();

  // Operator-backlog circuit breaker input — best-effort; on failure assume a
  // FULL backlog (fail-closed: don't promote when we can't see the queue).
  let openBacklog = Number.MAX_SAFE_INTEGER;
  try {
    openBacklog = await deps.countOpenBacklog();
  } catch (err) {
    logger.warn({ err }, "auto-promote: backlog count failed — treating as full (fail-closed)");
  }

  const ctx: PromotionContext = {
    repoAllowlist: parseRepoAllowlist(env.PLYNE_AUTO_PROMOTE_REPO_ALLOWLIST),
    repo: input.repo,
    minAgeMs: env.PLYNE_AUTO_PROMOTE_MIN_AGE_MS,
    nowMs: Date.now(),
    openBacklog,
    maxOpenBacklog: env.PLYNE_AUTO_PROMOTE_MAX_OPEN_BACKLOG,
    rateLimitOk: limiter.hasCapacity()
  };

  const decision = evaluatePromotion(input.signal, ctx);

  if (!decision.promote) {
    logger.info(
      { externalId: input.externalId, repo: input.repo, reason: decision.reason },
      "auto-promote: not promoting (policy)"
    );
    return { qualified: false, promoted: false, dryRun: !env.PLYNE_AUTO_PROMOTE, reason: decision.reason };
  }

  // Rewrite the id to a runner-visible prefix so listReadyTasks() will claim it.
  // INGEST-SENTRY-ABC → V3-AUTO-SENTRY-ABC (strip a leading INGEST- if present).
  const tail = input.externalId.replace(/^INGEST-/, "");
  const newExternalId = `${env.PLYNE_AUTO_PROMOTE_PREFIX}${tail}`.slice(0, 60);

  if (!env.PLYNE_AUTO_PROMOTE) {
    // DRY-RUN — flag off. Log loudly so the operator sees exactly what the
    // policy WOULD have done, but write nothing.
    logger.warn(
      {
        externalId: input.externalId,
        wouldBecome: newExternalId,
        repo: input.repo,
        severity: input.signal.severity,
        source: input.signal.source
      },
      "auto-promote: DRY-RUN — would promote backlog→ready (PLYNE_AUTO_PROMOTE is off)"
    );
    return { qualified: true, promoted: false, dryRun: true, reason: "dry_run", newExternalId };
  }

  // LIVE — consume a rate-limit slot and write.
  try {
    await deps.promoteTask(input.pageId, newExternalId);
    limiter.record();
    logger.info(
      {
        externalId: input.externalId,
        newExternalId,
        repo: input.repo,
        severity: input.signal.severity,
        rateWindowCount: limiter.count(),
        automerge: env.PLYNE_AUTO_PROMOTE_AUTOMERGE
      },
      "auto-promote: PROMOTED backlog→ready (live)"
    );
    return { qualified: true, promoted: true, dryRun: false, reason: "promoted", newExternalId };
  } catch (err) {
    logger.error(
      { externalId: input.externalId, err },
      "auto-promote: promote write FAILED — task stays in backlog for operator"
    );
    return { qualified: true, promoted: false, dryRun: false, reason: "promote_write_failed", newExternalId };
  }
}

/** Test seam — reset the singleton limiter between cases. */
export const __test = {
  resetLimiter(): void {
    _limiter = undefined;
  }
};
