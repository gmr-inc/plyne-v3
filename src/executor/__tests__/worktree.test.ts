/**
 * worktree tests — the resilient-retry cleanup logic + git-worktree-add flow.
 *
 * All git calls are mocked through the injectable `GitRunner`/`FsLike` deps, so
 * these run under `node --test` with no real git, no network, no VPS layout.
 *
 * Run locally: node --import tsx --test src/executor/__tests__/worktree.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createWorktree,
  prepareCleanBranch,
  findWorktreeDirForBranch,
  safeBranchSlug,
  type GitResult,
  type GitRunner,
  type FsLike
} from "../worktree.js";

/** A fake git that returns scripted results keyed by the subcommand. */
interface ScriptedCall {
  args: string[];
}

function ok(stdout = ""): GitResult {
  return { status: 0, stdout, stderr: "" };
}
function fail(stderr = "boom", status = 128): GitResult {
  return { status, stdout: "", stderr };
}

/**
 * Build a mock GitRunner whose behaviour is driven by a handler keyed on the
 * first one/two args. Records every call for assertions.
 */
function makeGit(
  handler: (args: string[]) => GitResult
): { git: GitRunner; calls: ScriptedCall[] } {
  const calls: ScriptedCall[] = [];
  const git: GitRunner = (args) => {
    calls.push({ args });
    return handler(args);
  };
  return { git, calls };
}

function key(args: string[]): string {
  // e.g. ["worktree","add",...] -> "worktree add"; ["branch","-D",..] -> "branch -D"
  return args.slice(0, 2).join(" ");
}

function calledWith(calls: ScriptedCall[], prefix: string): boolean {
  return calls.some((c) => c.args.join(" ").includes(prefix));
}

describe("safeBranchSlug", () => {
  it("produces a deterministic cto-v3/task-<slug> branch", () => {
    assert.equal(safeBranchSlug("V3-TEST-GIT-PR-001"), "cto-v3/task-v3-test-git-pr-001");
  });
  it("is stable across calls for the same task id (this is why retries collide)", () => {
    assert.equal(safeBranchSlug("V3-TEST-X"), safeBranchSlug("V3-TEST-X"));
  });
});

describe("findWorktreeDirForBranch", () => {
  const porcelain = [
    "worktree /home/plyne/Desktop/Projects/repo",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /tmp/plyne-v3-worktrees/task-x-123",
    "HEAD def456",
    "branch refs/heads/cto-v3/task-x",
    ""
  ].join("\n");

  it("finds the dir bound to the target branch", () => {
    assert.equal(
      findWorktreeDirForBranch(porcelain, "cto-v3/task-x"),
      "/tmp/plyne-v3-worktrees/task-x-123"
    );
  });
  it("returns null when no worktree holds the branch", () => {
    assert.equal(findWorktreeDirForBranch(porcelain, "cto-v3/task-missing"), null);
  });
  it("does not match a substring branch name", () => {
    assert.equal(findWorktreeDirForBranch(porcelain, "cto-v3/task-x-extra"), null);
  });
});

describe("prepareCleanBranch", () => {
  const branch = "cto-v3/task-x";

  it("is a no-op (beyond prune + list) when nothing is stale", () => {
    const { git, calls } = makeGit((args) => {
      const k = key(args);
      if (k === "worktree prune") return ok();
      if (k === "worktree list") return ok(""); // no worktrees
      if (k === "rev-parse --verify") return fail("no branch", 1); // branch absent
      return ok();
    });
    prepareCleanBranch(git, branch, "task-x", "repo");
    assert.ok(calledWith(calls, "worktree prune"));
    assert.ok(!calledWith(calls, "branch -D")); // nothing to delete
    assert.ok(!calledWith(calls, "worktree remove")); // nothing to remove
  });

  it("removes a stale worktree dir bound to the branch", () => {
    const porcelain = [
      "worktree /tmp/plyne-v3-worktrees/task-x-1",
      "branch refs/heads/cto-v3/task-x",
      ""
    ].join("\n");
    const { git, calls } = makeGit((args) => {
      const k = key(args);
      if (k === "worktree prune") return ok();
      if (k === "worktree list") return ok(porcelain);
      if (k === "worktree remove") return ok();
      if (k === "rev-parse --verify") return fail("no branch", 1);
      return ok();
    });
    prepareCleanBranch(git, branch, "task-x", "repo");
    assert.ok(
      calls.some((c) => c.args.join(" ") === "worktree remove --force /tmp/plyne-v3-worktrees/task-x-1")
    );
  });

  it("deletes a leftover local branch (the bug scenario)", () => {
    const { git, calls } = makeGit((args) => {
      const k = key(args);
      if (k === "worktree prune") return ok();
      if (k === "worktree list") return ok("");
      if (k === "rev-parse --verify") return ok(); // branch EXISTS
      if (k === "branch -D") return ok();
      return ok();
    });
    prepareCleanBranch(git, branch, "task-x", "repo");
    assert.ok(calls.some((c) => c.args.join(" ") === `branch -D ${branch}`));
  });

  it("throws a clear error if removing the stale worktree fails", () => {
    const porcelain = ["worktree /tmp/x", "branch refs/heads/cto-v3/task-x", ""].join("\n");
    const { git } = makeGit((args) => {
      const k = key(args);
      if (k === "worktree prune") return ok();
      if (k === "worktree list") return ok(porcelain);
      if (k === "worktree remove") return fail("locked");
      return ok();
    });
    assert.throws(
      () => prepareCleanBranch(git, branch, "task-x", "repo"),
      /worktree cleanup failed.*could not remove stale worktree/
    );
  });

  it("throws a clear error if deleting the stale branch fails", () => {
    const { git } = makeGit((args) => {
      const k = key(args);
      if (k === "worktree prune") return ok();
      if (k === "worktree list") return ok("");
      if (k === "rev-parse --verify") return ok();
      if (k === "branch -D") return fail("unmerged");
      return ok();
    });
    assert.throws(
      () => prepareCleanBranch(git, branch, "task-x", "repo"),
      /worktree cleanup failed.*could not delete stale branch/
    );
  });

  it("tolerates a prune failure and still cleans the branch", () => {
    const { git, calls } = makeGit((args) => {
      const k = key(args);
      if (k === "worktree prune") return fail("prune err");
      if (k === "worktree list") return ok("");
      if (k === "rev-parse --verify") return ok();
      if (k === "branch -D") return ok();
      return ok();
    });
    prepareCleanBranch(git, branch, "task-x", "repo");
    assert.ok(calls.some((c) => c.args.join(" ") === `branch -D ${branch}`));
  });
});

describe("createWorktree (with injected deps)", () => {
  const repoPath = "/home/plyne/Desktop/Projects/repo";

  // An fs mock whose existsSync(cwd) is controllable.
  function makeFs(existsResult: boolean): { fs: FsLike; removed: string[] } {
    const removed: string[] = [];
    const fsImpl: FsLike = {
      existsSync: () => existsResult,
      rmSync: (p) => {
        removed.push(p);
      }
    };
    return { fs: fsImpl, removed };
  }

  it("(a) fresh creation: prune→list→add, returns worktree on the task branch", () => {
    const { git, calls } = makeGit((args) => {
      const k = key(args);
      if (k === "worktree prune") return ok();
      if (k === "worktree list") return ok(""); // nothing stale
      if (k === "rev-parse --verify") return fail("no branch", 1); // branch absent
      if (k === "worktree add") return ok();
      return ok();
    });
    const { fs } = makeFs(false);

    const wt = createWorktree("V3-TEST-X", "repo", {
      git,
      fs,
      sourceRepoPathOverride: repoPath,
      skipFetch: true
    });

    assert.equal(wt.branch, "cto-v3/task-v3-test-x");
    assert.equal(wt.sourceRepoPath, repoPath);
    // No destructive cleanup happened on a fresh repo.
    assert.ok(!calledWith(calls, "branch -D"));
    assert.ok(!calledWith(calls, "worktree remove"));
    // The add actually ran with -b <branch> origin/main.
    assert.ok(
      calls.some(
        (c) =>
          c.args[0] === "worktree" &&
          c.args[1] === "add" &&
          c.args.includes("-b") &&
          c.args.includes("cto-v3/task-v3-test-x") &&
          c.args.includes("origin/main")
      )
    );
  });

  it("(b) THE BUG: branch already exists from a failed run — retry self-heals and succeeds", () => {
    let branchDeleted = false;
    const { git, calls } = makeGit((args) => {
      const k = key(args);
      if (k === "worktree prune") return ok();
      if (k === "worktree list") return ok("");
      if (k === "rev-parse --verify") return branchDeleted ? fail("gone", 1) : ok(); // exists until deleted
      if (k === "branch -D") {
        branchDeleted = true;
        return ok();
      }
      if (k === "worktree add") {
        // Simulate the real git: if the branch still existed, add would fail.
        return branchDeleted ? ok() : fail("fatal: a branch named 'cto-v3/task-x' already exists");
      }
      return ok();
    });
    const { fs } = makeFs(false);

    const wt = createWorktree("V3-TEST-X", "repo", {
      git,
      fs,
      sourceRepoPathOverride: repoPath,
      skipFetch: true
    });

    // The stale branch was deleted before the add, and the add succeeded.
    assert.ok(calls.some((c) => c.args.join(" ") === "branch -D cto-v3/task-v3-test-x"));
    assert.equal(wt.branch, "cto-v3/task-v3-test-x");
    // Add ran exactly once and did not throw.
    const addCalls = calls.filter((c) => key(c.args) === "worktree add");
    assert.equal(addCalls.length, 1);
  });

  it("(c) stale worktree dir on disk (git unaware): leftover cwd is removed before add", () => {
    const { git } = makeGit((args) => {
      const k = key(args);
      if (k === "worktree prune") return ok();
      if (k === "worktree list") return ok("");
      if (k === "rev-parse --verify") return fail("no branch", 1);
      if (k === "worktree add") return ok();
      return ok();
    });
    // existsSync(cwd) === true => the defensive rm of the leftover dir must fire.
    const { fs, removed } = makeFs(true);

    const wt = createWorktree("V3-TEST-X", "repo", {
      git,
      fs,
      sourceRepoPathOverride: repoPath,
      skipFetch: true
    });

    assert.ok(removed.length >= 1, "expected leftover cwd to be removed");
    assert.equal(wt.branch, "cto-v3/task-v3-test-x");
  });

  it("falls back to scratch dir (no branch) when the repo can't be located", () => {
    const { git } = makeGit(() => ok());
    const wt = createWorktree("V3-TEST-X", "repo", {
      git,
      sourceRepoPathOverride: null
    });
    assert.equal(wt.branch, null);
    assert.equal(wt.sourceRepoPath, null);
  });

  it("throws (does NOT silently fall back) when add fails for a non-branch reason", () => {
    const { git } = makeGit((args) => {
      const k = key(args);
      if (k === "worktree prune") return ok();
      if (k === "worktree list") return ok("");
      if (k === "rev-parse --verify") return fail("no branch", 1);
      if (k === "worktree add") return fail("fatal: disk full");
      return ok();
    });
    const { fs } = makeFs(false);
    assert.throws(
      () =>
        createWorktree("V3-TEST-X", "repo", {
          git,
          fs,
          sourceRepoPathOverride: repoPath,
          skipFetch: true
        }),
      /git worktree add failed/
    );
  });
});
