/**
 * Worktree manager — gives each task a real git worktree on a fresh branch.
 *
 * v3.1 fix: the original v3 stripdown created an empty temp dir, which meant
 * Claude wrote orphan files with no .git ancestry — no commit, no push, no PR
 * possible. We now back the worktree by `git worktree add` against the local
 * clone of the task's repo, so Claude inherits the full repo state and we can
 * commit/push/PR after it exits.
 *
 * v3.2 fix (resilient retry): the branch name is DETERMINISTIC per task
 * (`cto-v3/task-<slug>`). When a prior run failed, it could leave that branch
 * — and/or a half-built worktree dir — behind. The next attempt then did
 * `git worktree add <path> -b <branch> origin/main` and git aborted with
 * `fatal: a branch named 'cto-v3/task-...' already exists`, so the task died
 * at worktree creation and could NEVER be retried (permanently stuck). We now
 * clean up stale per-task state before adding, making creation idempotent: a
 * retry always produces a clean worktree on the task branch. See
 * `prepareCleanBranch()` for the safety policy.
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
// Was `/root/Desktop/Projects` pre-2026-06-01 when Plyne ran as root on the
// Hetzner VPS. Migration to non-root `plyne` user is now permanent; if a
// future infra change moves this base, update + run `assertLocalReposBase()`
// at boot to catch the drift immediately rather than per-task at runtime.
const LOCAL_REPOS_BASE = "/home/plyne/Desktop/Projects";

/**
 * Boot-time guard: if LOCAL_REPOS_BASE doesn't exist (or isn't a directory),
 * fail-fast instead of letting every task hit `Failed to create worktree:
 * cannot change to '<base>/<repo>': Permission denied` at runtime. This is
 * what bit us during the root→plyne user migration: code had been updated,
 * but the bind / chmod hadn't propagated, and tasks died one by one with
 * cryptic errors.
 */
export function assertLocalReposBase(): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(LOCAL_REPOS_BASE);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `FATAL: LOCAL_REPOS_BASE not accessible: ${LOCAL_REPOS_BASE} ` +
        `(${(err as Error).message}). The VPS layout expects per-repo clones ` +
        `under this directory — see src/executor/worktree.ts.`
    );
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    // eslint-disable-next-line no-console
    console.error(`FATAL: LOCAL_REPOS_BASE exists but is not a directory: ${LOCAL_REPOS_BASE}`);
    process.exit(1);
  }
}

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

/**
 * Result of running a git subcommand. Mirrors the slice of `spawnSync`'s
 * return that we care about. Abstracted behind an interface so the cleanup
 * logic is unit-testable without spawning real `git`.
 */
export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `git -C <cwd> <args...>` and returns a normalised result. */
export type GitRunner = (args: string[], opts?: { timeoutMs?: number }) => GitResult;

/** Minimal fs surface the cleanup logic needs; injectable for tests. */
export interface FsLike {
  existsSync: (p: string) => boolean;
  rmSync: (p: string, opts: { recursive: boolean; force: boolean }) => void;
}

/** Dependencies injectable into `createWorktree` for unit testing. */
export interface WorktreeDeps {
  /** git runner already bound to the source repo (`git -C <repo>`). */
  git: GitRunner;
  fs: FsLike;
}

function realGitRunner(repoPath: string): GitRunner {
  return (args, opts) => {
    const res = spawnSync("git", ["-C", repoPath, ...args], {
      timeout: opts?.timeoutMs ?? 60_000
    });
    return {
      status: res.status,
      stdout: res.stdout?.toString() ?? "",
      stderr: res.stderr?.toString() ?? ""
    };
  };
}

const realFs: FsLike = {
  existsSync: (p) => fs.existsSync(p),
  rmSync: (p, opts) => fs.rmSync(p, opts)
};

export function safeBranchSlug(taskId: string): string {
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

function branchExists(git: GitRunner, branch: string): boolean {
  // `git rev-parse --verify --quiet refs/heads/<branch>` exits 0 iff the local
  // branch ref exists. We pin the full `refs/heads/` path so a same-named tag
  // or remote ref can't produce a false positive.
  const res = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { timeoutMs: 15_000 });
  return res.status === 0;
}

/**
 * Make the per-task branch safe to (re)create as a fresh worktree.
 *
 * Policy — chosen to GUARANTEE a clean retry without orphaning work:
 *
 *   1. `git worktree prune` first — drops registry entries whose dirs vanished
 *      (the "git knows about a worktree but the dir is gone" case).
 *   2. If a worktree dir for THIS task's branch is still checked out anywhere,
 *      remove it with `git worktree remove --force` so the branch is no longer
 *      "checked out elsewhere" (which would block reuse) and no stale sandbox
 *      lingers. We force because the previous run may have left a dirty tree.
 *   3. If the branch still exists, we DELETE it with `git branch -D` and let the
 *      caller recreate it fresh from origin/main.
 *
 *      Why delete rather than reuse+reset? The branch is created locally and is
 *      only ever pushed by the downstream git-push-pr step AFTER a successful
 *      run. So a leftover LOCAL-only branch from a *failed* run carries no
 *      merged/open PR and no work we committed to keep — deleting it cannot
 *      orphan anything that downstream cares about. If a run had pushed and a
 *      PR existed, `git push` from the recreated branch is non-fast-forward and
 *      would be rejected loudly rather than silently clobbering — but in
 *      practice the branch is local-only at this point, so `-D` is safe.
 *      `git branch -D` only touches the LOCAL ref; it never deletes the remote.
 *
 * Idempotent: safe to call whether or not the branch / worktree dir exists.
 * Throws if a cleanup git command fails unexpectedly (so the caller surfaces a
 * clear "cleanup failed" error instead of the original cryptic add failure).
 */
export function prepareCleanBranch(git: GitRunner, branch: string, taskId: string, repo: string): void {
  // 1. Reconcile git's worktree registry with what's actually on disk. Best
  //    effort: prune never fails on a healthy repo, but if it does we log and
  //    continue — the targeted steps below are what actually unblock the retry.
  const prune = git(["worktree", "prune"], { timeoutMs: 15_000 });
  if (prune.status !== 0) {
    logger.warn(
      { taskId, repo, stderr: prune.stderr.slice(0, 300) },
      "worktree: git worktree prune failed (continuing)"
    );
  }

  // 2. If the branch is checked out in some leftover worktree, that worktree
  //    must go before we can delete/reuse the branch. `git worktree list
  //    --porcelain` emits `branch refs/heads/<name>` lines under each entry's
  //    `worktree <path>` line; find the path bound to our branch and remove it.
  const list = git(["worktree", "list", "--porcelain"], { timeoutMs: 15_000 });
  if (list.status === 0) {
    const staleDir = findWorktreeDirForBranch(list.stdout, branch);
    if (staleDir) {
      logger.info({ taskId, repo, branch, staleDir }, "worktree: removing stale worktree for task branch");
      const rm = git(["worktree", "remove", "--force", staleDir], { timeoutMs: 30_000 });
      if (rm.status !== 0) {
        throw new Error(
          `worktree cleanup failed: could not remove stale worktree ${staleDir} for branch=${branch}: ${rm.stderr.slice(0, 300)}`
        );
      }
    }
  } else {
    logger.warn(
      { taskId, repo, stderr: list.stderr.slice(0, 300) },
      "worktree: git worktree list failed during cleanup (continuing)"
    );
  }

  // 3. Delete the leftover local branch (see policy doc above for why -D is
  //    safe here). Only act if it actually exists, to keep this idempotent and
  //    avoid noisy "branch not found" errors on the happy path.
  if (branchExists(git, branch)) {
    logger.info({ taskId, repo, branch }, "worktree: deleting stale local task branch before recreate");
    const del = git(["branch", "-D", branch], { timeoutMs: 15_000 });
    if (del.status !== 0) {
      throw new Error(
        `worktree cleanup failed: could not delete stale branch ${branch}: ${del.stderr.slice(0, 300)}`
      );
    }
  }
}

/**
 * Parse `git worktree list --porcelain` output and return the worktree path
 * whose `branch` line matches `refs/heads/<branch>`, or null if none.
 *
 * Porcelain format is record-per-worktree, blank-line separated, e.g.:
 *   worktree /home/plyne/Desktop/Projects/repo
 *   HEAD abc123
 *   branch refs/heads/main
 *
 *   worktree /tmp/plyne-v3-worktrees/task-x-123
 *   HEAD def456
 *   branch refs/heads/cto-v3/task-x
 */
export function findWorktreeDirForBranch(porcelain: string, branch: string): string | null {
  const wantRef = `refs/heads/${branch}`;
  let currentPath: string | null = null;
  for (const raw of porcelain.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      if (ref === wantRef && currentPath) {
        return currentPath;
      }
    } else if (line === "") {
      currentPath = null;
    }
  }
  return null;
}

export function createWorktree(
  taskId: string,
  repo: string,
  deps?: Partial<WorktreeDeps> & { sourceRepoPathOverride?: string | null; skipFetch?: boolean }
): Worktree {
  fs.mkdirSync(env.WORKTREE_BASE, { recursive: true });
  const cwd = path.join(env.WORKTREE_BASE, `task-${taskId}-${Date.now()}`);

  const sourceRepoPath =
    deps?.sourceRepoPathOverride !== undefined ? deps.sourceRepoPathOverride : repoExists(repo);
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

  const git: GitRunner = deps?.git ?? realGitRunner(sourceRepoPath);
  const fsImpl: FsLike = deps?.fs ?? realFs;

  // Make sure we have an up-to-date `main` to branch from. Best-effort: a
  // fetch failure should not kill the task (we still have origin/main locally).
  if (!deps?.skipFetch) {
    const fetch = git(["fetch", "origin", "main", "--quiet"], { timeoutMs: 60_000 });
    if (fetch.status !== 0) {
      logger.warn(
        { taskId, repo, stderr: fetch.stderr.slice(0, 300) },
        "worktree: git fetch origin main failed (continuing with local state)"
      );
    }
  }

  const branch = safeBranchSlug(taskId);

  // ── v3.2 resilient retry ────────────────────────────────────────────────
  // Self-heal any stale per-task state left behind by a previous failed run so
  // `git worktree add` below never hits "a branch named '...' already exists".
  // This is the core of the fix: it makes creation idempotent. If cleanup
  // itself fails we throw a clear "cleanup failed" error rather than letting
  // the cryptic add error resurface.
  prepareCleanBranch(git, branch, taskId, repo);

  // Also guard the "leftover dir on disk but git doesn't know about it" case:
  // if our freshly-computed cwd somehow already exists (timestamp collision /
  // crash debris), `git worktree add` would refuse with "already exists".
  // Remove it defensively — cwd is a per-task path under WORKTREE_BASE we own.
  if (fsImpl.existsSync(cwd)) {
    try {
      fsImpl.rmSync(cwd, { recursive: true, force: true });
    } catch (err) {
      throw new Error(
        `worktree cleanup failed: could not remove leftover dir ${cwd}: ${(err as Error).message}`
      );
    }
  }

  // `git worktree add <path> -b <branch> origin/main` creates the branch from
  // origin/main and checks it out into the new worktree in one shot. After the
  // cleanup above, the branch is guaranteed not to pre-exist, so this is safe
  // on a retry.
  const add = git(["worktree", "add", cwd, "-b", branch, "origin/main"], { timeoutMs: 90_000 });
  if (add.status !== 0) {
    const stderr = add.stderr;
    logger.error(
      { taskId, repo, branch, stderr: stderr.slice(0, 500) },
      "worktree: git worktree add failed"
    );
    // Cleanup any partial dir then throw — the runner will mark the task
    // needs-operator. Hiding a worktree failure behind a scratch dir would
    // silently re-create the original bug.
    try {
      fsImpl.rmSync(cwd, { recursive: true, force: true });
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
      const rm = git(["worktree", "remove", "--force", cwd], { timeoutMs: 30_000 });
      if (rm.status !== 0) {
        try {
          fsImpl.rmSync(cwd, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  };
}
