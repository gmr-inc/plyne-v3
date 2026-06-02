/**
 * Worktree manager — gives each task a real git worktree on a fresh branch.
 *
 * v3.1 fix: the original v3 stripdown created an empty temp dir, which meant
 * Claude wrote orphan files with no .git ancestry — no commit, no push, no PR
 * possible. We now back the worktree by `git worktree add` against the local
 * clone of the task's repo, so Claude inherits the full repo state and we can
 * commit/push/PR after it exits.
 *
 * Layout convention on the Hetzner VPS:
 *   /home/plyne/Desktop/Projects/<repo>/    (the canonical local clone)
 *   <WORKTREE_BASE>/task-<externalId>-<ts>/ (per-task worktree)
 *
 * If the repo can't be located, we fall back to a plain mkdir so single-shot
 * "scratch" tasks still run — but no commit/push will happen in that mode.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";

const env = loadEnv();

// Local clones live here on the VPS. Each subdir name == Notion `Repo` value.
const LOCAL_REPOS_BASE = "/home/plyne/Desktop/Projects";

export interface Worktree {
  taskId: string;
  cwd: string;
  /** Absolute path to the source repo this worktree was carved from, or null
   *  when the repo couldn't be located and we fell back to a scratch dir. */
  sourceRepoPath: string | null;
  /** Branch name created for this task; null in scratch-dir fallback. */
  branch: string | null;
  /** Repo slug from the Notion task (== local dir name). */
  repo: string;
  destroy: () => void;
}

function safeBranchSlug(taskId: string): string {
  // Allow only [a-z0-9-_/]; lowercase; collapse dashes. Truncate to 60 chars
  // so refs stay below filesystem path-length limits when combined with the
  // worktree temp dir prefix. Notion task Name often glues the task code +
  // description into one string (e.g. "V3-TEST-GIT-PR-001 Plyne v3 git+pr…");
  // we keep the head, which is the unique part.
  const slug = taskId.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `cto-v3/task-${slug.slice(0, 60)}`;
}

function repoExists(repo: string): string | null {
  if (!repo) return null;
  const candidate = path.join(LOCAL_REPOS_BASE, repo);
  try {
    if (fs.statSync(candidate).isDirectory() && fs.existsSync(path.join(candidate, ".git"))) {
      return candidate;
    }
  } catch {
    /* not found */
  }
  return null;
}

export function createWorktree(taskId: string, repo: string): Worktree {
  fs.mkdirSync(env.WORKTREE_BASE, { recursive: true });
  const cwd = path.join(env.WORKTREE_BASE, `task-${taskId}-${Date.now()}`);

  const sourceRepoPath = repoExists(repo);
  if (!sourceRepoPath) {
    logger.warn(
      { taskId, repo, lookedIn: path.join(LOCAL_REPOS_BASE, repo) },
      "worktree: local repo clone not found — falling back to scratch dir (no commit/push will happen)"
    );
    fs.mkdirSync(cwd, { recursive: true });
    return {
      taskId,
      cwd,
      sourceRepoPath: null,
      branch: null,
      repo,
      destroy: () => {
        try {
          fs.rmSync(cwd, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    };
  }

  // Make sure we have an up-to-date `main` to branch from. Best-effort: a
  // fetch failure should not kill the task (we still have origin/main locally).
  const fetch = spawnSync("git", ["-C", sourceRepoPath, "fetch", "origin", "main", "--quiet"], {
    timeout: 60_000
  });
  if (fetch.status !== 0) {
    logger.warn(
      { taskId, repo, stderr: fetch.stderr?.toString().slice(0, 300) },
      "worktree: git fetch origin main failed (continuing with local state)"
    );
  }

  const branch = safeBranchSlug(taskId);
  // `git worktree add <path> -b <branch> origin/main` creates the branch from
  // origin/main and checks it out into the new worktree in one shot.
  const add = spawnSync(
    "git",
    ["-C", sourceRepoPath, "worktree", "add", cwd, "-b", branch, "origin/main"],
    { timeout: 90_000 }
  );
  if (add.status !== 0) {
    const stderr = add.stderr?.toString() ?? "";
    logger.error(
      { taskId, repo, branch, stderr: stderr.slice(0, 500) },
      "worktree: git worktree add failed"
    );
    // Cleanup any partial dir then throw — the runner will mark the task
    // needs-operator. Hiding a worktree failure behind a scratch dir would
    // silently re-create the original bug.
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw new Error(`git worktree add failed for repo=${repo} branch=${branch}: ${stderr.slice(0, 300)}`);
  }

  logger.info({ taskId, repo, cwd, branch, sourceRepoPath }, "worktree: created git worktree");

  return {
    taskId,
    cwd,
    sourceRepoPath,
    branch,
    repo,
    destroy: () => {
      // Use `git worktree remove --force` so git's worktree registry stays
      // consistent. Fall back to rm -rf if the git command fails (e.g. when
      // sourceRepoPath was wiped between create + destroy).
      const rm = spawnSync(
        "git",
        ["-C", sourceRepoPath, "worktree", "remove", "--force", cwd],
        { timeout: 30_000 }
      );
      if (rm.status !== 0) {
        try {
          fs.rmSync(cwd, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  };
}
