/**
 * git-push-pr — after Claude exits cleanly, commit any changes in the
 * worktree, push the branch, and open a PR via `gh`.
 *
 * Plyne v3 design contract:
 *   - We DO NOT auto-merge. The operator merges manually.
 *   - We DO open the PR so the human review loop can start.
 *   - If there are no changes, we return null and the runner treats the task
 *     as needs-operator (since v3 expects every task to produce SOMETHING).
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { logger } from "../config/logger.js";
import type { Task } from "../notion/client.js";

export interface PushPrResult {
  prUrl: string;
  branch: string;
  commitSha: string;
}

const GH_ORG = "gmr-inc";

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): SpawnSyncReturns<Buffer> {
  return spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    timeout: opts.timeoutMs ?? 60_000
  });
}

function ensureGitIdentity(cwd: string): void {
  // Plyne v3 commits as Alberto via the GH_TOKEN identity — but `git commit`
  // also needs a local user.name + user.email or it errors out. Set worktree-
  // local config (does not leak into the source repo's global config).
  run("git", ["config", "user.name", "Plyne v3 (Alberto Nasciuti)"], { cwd });
  run("git", ["config", "user.email", "alberto.nasciuti+plyne-v3@kpi6.com"], { cwd });
}

function hasStagedOrUnstagedChanges(cwd: string): boolean {
  const status = run("git", ["status", "--porcelain"], { cwd });
  return (status.stdout?.toString().trim().length ?? 0) > 0;
}

function buildPrBody(task: Task, bodySuffix?: string): string {
  return [
    `## Task`,
    `**${task.externalId}** — ${task.title}`,
    ``,
    `Notion page: \`${task.id}\``,
    `Product: \`${task.product}\` | Repo: \`${task.repo}\` | Effort: \`${task.effort ?? "?"}\``,
    ``,
    `## Instructions`,
    task.instructions || "_(none)_",
    ``,
    `## Acceptance Criteria`,
    task.acceptanceCriteria || "_(none)_",
    // AC results (machine-verified by Plyne v3 before the PR was opened) are
    // appended here when the runner verified them — see ac-runner.ts.
    ...(bodySuffix ? [``, bodySuffix] : []),
    ``,
    `---`,
    `Opened by Plyne v3. AC pre-verified; merge gated on CI + CodeRabbit.`
  ].join("\n");
}

/**
 * Commit + push + open PR. Returns null if there is nothing to commit (Claude
 * exited clean but produced no diff — operator decides what to do).
 */
export async function pushAndOpenPR(
  task: Task,
  cwd: string,
  branch: string,
  childEnv: NodeJS.ProcessEnv,
  /** Optional Markdown appended to the PR body (e.g. the "## AC results" section). */
  bodySuffix?: string
): Promise<PushPrResult | null> {
  if (!task.repo) {
    logger.warn({ taskId: task.externalId }, "git-push-pr: task has no repo, skipping");
    return null;
  }

  ensureGitIdentity(cwd);

  // Stage everything (including deletions). Plyne v3 prompt tells Claude to
  // not touch files outside its task scope, and the worktree isolation means
  // a stray `node_modules/` would only pollute the throwaway worktree.
  const add = run("git", ["add", "-A"], { cwd });
  if (add.status !== 0) {
    logger.error({ taskId: task.externalId, stderr: add.stderr?.toString().slice(0, 300) }, "git add failed");
    return null;
  }

  if (!hasStagedOrUnstagedChanges(cwd)) {
    logger.info({ taskId: task.externalId, branch }, "git-push-pr: no changes to commit");
    return null;
  }

  const commitMsg = `[${task.externalId}] ${task.title}\n\nOpened by Plyne v3. Notion: ${task.id}`;
  const commit = run("git", ["commit", "-m", commitMsg], { cwd });
  if (commit.status !== 0) {
    logger.error(
      { taskId: task.externalId, stderr: commit.stderr?.toString().slice(0, 500) },
      "git commit failed"
    );
    return null;
  }

  const revparse = run("git", ["rev-parse", "HEAD"], { cwd });
  const commitSha = revparse.stdout?.toString().trim() ?? "";

  // Push the branch. `-u origin <branch>` sets upstream so future ops work.
  const push = run("git", ["push", "-u", "origin", branch], { cwd, env: childEnv, timeoutMs: 120_000 });
  if (push.status !== 0) {
    logger.error(
      { taskId: task.externalId, branch, stderr: push.stderr?.toString().slice(0, 500) },
      "git push failed"
    );
    return null;
  }

  // Open PR via gh. -R explicit so we don't depend on the worktree's remote
  // detection (worktrees share the source repo's remotes — fine, but explicit
  // is safer).
  const repoArg = `${GH_ORG}/${task.repo}`;
  const prTitle = `[${task.externalId}] ${task.title}`;
  const prBody = buildPrBody(task, bodySuffix);
  const ghPr = run(
    "gh",
    ["pr", "create", "-R", repoArg, "--head", branch, "--base", "main", "--title", prTitle, "--body", prBody],
    { cwd, env: childEnv, timeoutMs: 90_000 }
  );
  if (ghPr.status !== 0) {
    logger.error(
      { taskId: task.externalId, repoArg, branch, stderr: ghPr.stderr?.toString().slice(0, 800) },
      "gh pr create failed"
    );
    return null;
  }

  const prUrl = ghPr.stdout?.toString().trim().split("\n").find((l) => l.startsWith("http")) ?? "";
  if (!prUrl) {
    logger.warn(
      { taskId: task.externalId, stdout: ghPr.stdout?.toString().slice(0, 300) },
      "gh pr create returned no URL"
    );
    return null;
  }

  logger.info({ taskId: task.externalId, prUrl, branch, commitSha }, "git-push-pr: PR opened");
  return { prUrl, branch, commitSha };
}
