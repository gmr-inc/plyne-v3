/**
 * Auto-merge loop — the second half of "make auto-merge SAFE".
 *
 * Part 1 (ac-runner) guarantees that by the time a task reaches `pr-open`, its
 * executable Acceptance Criteria already passed in the worktree. This loop
 * closes the cycle: it polls `pr-open` tasks and squash-merges each PR ONLY
 * when it is fully green (CI + CodeRabbit), then marks the task `done`.
 *
 * Safety properties (all enforced here):
 *   - Best-effort: every step is wrapped; a GitHub/Notion hiccup logs + skips,
 *     it never crashes the daemon (mirrors the runner's circuit-breaker ethos).
 *   - Idempotent: an in-memory `merging` set guards against double-merge inside
 *     a cycle; the `pr-open → done` status transition guards across cycles
 *     (a merged task leaves pr-open, so it's no longer polled).
 *   - Gated by PLYNE_V3_AUTO_MERGE (default true). When false, the loop never
 *     starts — v3 reverts to the operator-manual-merge behaviour.
 *
 * The merge decision itself lives in merge-gate.ts (pure, unit-tested). This
 * file only does the GitHub/Notion I/O around it.
 */
import { spawnSync } from "node:child_process";
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import {
  listTasksByStatus,
  setStatus,
  addComment,
  isNotionAuthError,
  type Task
} from "../notion/client.js";
import { decideMergeWithReason, type PrGateInput } from "../executor/merge-gate.js";
import { getEventBus } from "../lib/event-bus.js";
import { notify } from "../lib/notifications-writer.js";

const env = loadEnv();
const bus = getEventBus();

const GH_ORG = "gmr-inc";

/** In-flight guard so a slow merge isn't started twice within overlapping cycles. */
const merging = new Set<string>();

/**
 * Parse a GitHub PR URL into { owner, repo, number }. Returns null on anything
 * that doesn't look like a PR URL (we then skip the task, best-effort).
 */
export function parsePrUrl(url: string | null | undefined): { owner: string; repo: string; number: number } | null {
  if (!url) return null;
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!m) return null;
  const number = Number.parseInt(m[3] ?? "", 10);
  if (!m[1] || !m[2] || Number.isNaN(number)) return null;
  return { owner: m[1], repo: m[2], number };
}

function gh(args: string[], env_: NodeJS.ProcessEnv, timeoutMs = 60_000) {
  return spawnSync("gh", args, { env: env_, timeout: timeoutMs, encoding: "utf8" });
}

/**
 * Fetch the gate-relevant PR JSON via `gh pr view`. Returns null on any error
 * (network, gh missing, JSON parse) — the caller then waits and re-polls.
 */
export function fetchPrGateInput(
  ownerRepo: string,
  number: number,
  env_: NodeJS.ProcessEnv
): PrGateInput | null {
  const res = gh(
    [
      "pr",
      "view",
      String(number),
      "--repo",
      ownerRepo,
      "--json",
      "mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,reviews"
    ],
    env_
  );
  if (res.status !== 0 || !res.stdout) {
    logger.warn(
      { ownerRepo, number, stderr: (res.stderr ?? "").toString().slice(0, 300) },
      "auto-merge: gh pr view failed"
    );
    return null;
  }
  try {
    return JSON.parse(res.stdout) as PrGateInput;
  } catch (err) {
    logger.warn({ ownerRepo, number, err }, "auto-merge: gh pr view JSON parse failed");
    return null;
  }
}

/** Squash-merge + delete branch. Returns true on success. */
function squashMerge(ownerRepo: string, number: number, env_: NodeJS.ProcessEnv): boolean {
  const res = gh(["pr", "merge", String(number), "--repo", ownerRepo, "--squash", "--delete-branch"], env_, 120_000);
  if (res.status !== 0) {
    logger.error(
      { ownerRepo, number, stderr: (res.stderr ?? "").toString().slice(0, 400) },
      "auto-merge: gh pr merge failed"
    );
    return false;
  }
  return true;
}

async function processOnePrOpen(task: Task): Promise<void> {
  if (merging.has(task.id)) return;

  const parsed = parsePrUrl(task.prUrl);
  if (!parsed) {
    logger.warn({ taskId: task.externalId, prUrl: task.prUrl }, "auto-merge: no parseable PR URL — skipping");
    return;
  }
  // Default to gmr-inc/<repo> if the URL owner is odd, but prefer the URL's own.
  const ownerRepo = `${parsed.owner || GH_ORG}/${parsed.repo}`;

  const childEnv: NodeJS.ProcessEnv = { ...process.env };

  const gate = fetchPrGateInput(ownerRepo, parsed.number, childEnv);
  if (!gate) return; // transient — re-poll next cycle.

  const { decision, reason } = decideMergeWithReason(gate);
  logger.info(
    {
      taskId: task.externalId,
      ownerRepo,
      pr: parsed.number,
      decision,
      reason,
      mergeable: gate.mergeable,
      state: gate.mergeStateStatus,
      reviewDecision: gate.reviewDecision
    },
    `auto-merge: gate decision = ${decision} (${reason})`
  );

  if (decision === "wait") {
    logger.info(
      { taskId: task.externalId, pr: parsed.number, reason },
      `auto-merge: holding — ${reason}`
    );
    return;
  }

  if (decision === "skip") {
    // A check is RED (or CodeRabbit requested changes / conflict). Leave it for
    // the human: keep at pr-open but flip to needs-operator so the board
    // surfaces it. Idempotent: once it's needs-operator it's no longer polled.
    try {
      await setStatus(task.id, "needs-operator", task.prUrl ?? undefined);
      await addComment(
        task.id,
        [
          `**Plyne v3 auto-merge: held.**`,
          ``,
          `PR ${task.prUrl} is not green: ${reason}. ` +
            `mergeable=\`${gate.mergeable}\` state=\`${gate.mergeStateStatus}\` reviewDecision=\`${gate.reviewDecision}\`.`,
          ``,
          `Left for operator review — Plyne did NOT merge.`
        ].join("\n")
      );
    } catch (err) {
      logger.warn({ taskId: task.externalId, err }, "auto-merge: skip-path Notion write failed");
    }
    void notify({
      kind: "task_failed",
      severity: "warn",
      task_id: task.id,
      task_name: task.title || task.externalId,
      body: `Auto-merge held for ${task.externalId}: PR not green (${gate.mergeStateStatus ?? "?"})`,
      metadata: { external_id: task.externalId, pr_url: task.prUrl, product: task.product }
    });
    return;
  }

  // decision === "merge"
  merging.add(task.id);
  try {
    const ok = squashMerge(ownerRepo, parsed.number, childEnv);
    if (!ok) return; // best-effort — leave at pr-open, retry next cycle.

    // Mirror to Notion + Supabase (setStatus also calls mirrorTaskStatus).
    await setStatus(task.id, "done", task.prUrl ?? undefined);
    try {
      await addComment(
        task.id,
        [
          `**Plyne v3 auto-merged this PR.**`,
          ``,
          `PR ${task.prUrl} was fully green (CI + CodeRabbit) and the AC were ` +
            `pre-verified before it opened. Squash-merged + branch deleted.`
        ].join("\n")
      );
    } catch (err) {
      logger.warn({ taskId: task.externalId, err }, "auto-merge: merged-comment failed");
    }
    try {
      bus.emitActivity({
        event_type: "task.done",
        task_id: task.id,
        task_name: (task.title ?? "").slice(0, 200) || task.externalId,
        task_repo: task.repo || "(unknown)",
        details: { external_id: task.externalId, pr_url: task.prUrl, auto_merged: true }
      });
    } catch (err) {
      logger.warn({ taskId: task.externalId, err }, "auto-merge: emitActivity failed");
    }
    void notify({
      kind: "pr_opened",
      severity: "info",
      task_id: task.id,
      task_name: task.title || task.externalId,
      body: `Auto-merged ${task.externalId}: ${task.prUrl}`,
      metadata: { external_id: task.externalId, pr_url: task.prUrl, product: task.product, auto_merged: true }
    });
    logger.info({ taskId: task.externalId, pr: parsed.number, ownerRepo }, "auto-merge: merged + task done");
  } finally {
    merging.delete(task.id);
  }
}

async function cycle(): Promise<void> {
  let tasks: Task[];
  try {
    tasks = await listTasksByStatus("pr-open", env.PLYNE_V3_TASK_PREFIX);
  } catch (err) {
    if (isNotionAuthError(err)) {
      logger.error({ err }, "auto-merge: Notion auth error during poll — skipping cycle");
      return;
    }
    logger.warn({ err }, "auto-merge: listTasksByStatus failed — skipping cycle");
    return;
  }
  if (tasks.length === 0) return;
  logger.info({ count: tasks.length }, "auto-merge: pr-open tasks to evaluate");
  for (const t of tasks) {
    try {
      await processOnePrOpen(t);
    } catch (err) {
      // Hard guarantee: one task's failure never aborts the loop or crashes the daemon.
      logger.error({ taskId: t.externalId, err }, "auto-merge: processOnePrOpen threw");
    }
  }
}

let stopped = false;
let timer: NodeJS.Timeout | undefined;

export function startAutoMerge(): void {
  if (!env.PLYNE_V3_AUTO_MERGE) {
    logger.info("auto-merge: disabled via PLYNE_V3_AUTO_MERGE=false — operator merges manually");
    return;
  }
  logger.info(
    { pollMs: env.PLYNE_V3_AUTO_MERGE_INTERVAL_MS, prefix: env.PLYNE_V3_TASK_PREFIX },
    "auto-merge: starting loop"
  );
  const tick = async () => {
    if (stopped) return;
    try {
      await cycle();
    } catch (err) {
      logger.error({ err }, "auto-merge: cycle threw");
    } finally {
      if (!stopped) timer = setTimeout(tick, env.PLYNE_V3_AUTO_MERGE_INTERVAL_MS);
    }
  };
  void tick();
}

export function stopAutoMerge(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
}
