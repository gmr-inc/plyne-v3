/**
 * Claude CLI executor — spawns the `claude` CLI with a prompt + stack loaded.
 *
 * v2 had a 53k-byte file handling 12 marker types, fix-forward loops, attempt
 * retries, validator post-mortems. v3 is a single `spawn → wait → return
 * exit code + stdout + stderr`. v3.1 additionally hands the worktree's git
 * branch + source repo to the runner so it can commit/push/PR after Claude
 * exits.
 */
import { spawn } from "node:child_process";
import type { Task } from "../notion/client.js";
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createWorktree } from "./worktree.js";
import { loadStack } from "./stack-loader.js";

const env = loadEnv();

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  stackSummary: string;
  /** Absolute path to the worktree where Claude ran. Always set. */
  worktreeCwd: string;
  /** Branch created for this task, or null when worktree fell back to scratch. */
  branch: string | null;
  /** Source repo path the worktree was carved from, or null in scratch mode. */
  sourceRepoPath: string | null;
  /** Cleanup hook — caller MUST invoke after inspecting the worktree. */
  worktreeDestroy: () => void;
  /** Child-process env (token-bearing) — runner reuses for git push + gh pr. */
  childEnv: NodeJS.ProcessEnv;
}

function isExtendedThinkingEffort(effort: Task["effort"]): boolean {
  // Architecture §"Model selection": extended thinking on M/L/XL only.
  return effort === "M" || effort === "L" || effort === "XL";
}

function buildPrompt(task: Task, branch: string | null): string {
  // Plyne v3 prompt is intentionally minimal — Claude has its own hands
  // (MCP + Skills) and reads CLAUDE.md from the worktree. We feed it the
  // task contract verbatim, plus the git context so Claude knows it is
  // working inside a real branch (no `git init` / `git clone` needed).
  const gitBlock = branch
    ? [
        "## Git context",
        `You are inside a git worktree on branch \`${branch}\`, branched from \`origin/main\`.`,
        `Make your edits directly here. DO NOT \`git commit\` / \`git push\` / open a PR —`,
        `Plyne v3 handles commit + push + PR creation automatically after you exit.`,
        ""
      ].join("\n")
    : [
        "## Git context",
        "WARNING: the worktree is a scratch dir, not a git checkout. Any files you write",
        "will not be committed or PR'd. This usually means the task's `Repo` field does",
        "not match a local clone on the VPS. Write `PLYNE_V3_BLOCKED.txt` with the reason.",
        ""
      ].join("\n");

  return [
    `# Task: ${task.externalId} — ${task.title}`,
    "",
    `**Product:** ${task.product}`,
    `**Repo:** ${task.repo}`,
    `**Effort:** ${task.effort ?? "unknown"}`,
    `**Notion page id:** ${task.id}`,
    "",
    gitBlock,
    "## Instructions",
    task.instructions || "(no instructions provided)",
    "",
    "## Acceptance Criteria",
    task.acceptanceCriteria || "(no AC provided)",
    "",
    "## How to report",
    "When done, write a file `PLYNE_V3_DONE.txt` in the current working",
    "directory containing a one-line summary. Plyne v3 reads that marker and",
    "then commits + pushes + opens the PR. If you cannot finish, write",
    "`PLYNE_V3_BLOCKED.txt` instead with a one-line reason."
  ].join("\n");
}

export async function executeTask(task: Task): Promise<ExecutionResult> {
  const started = Date.now();
  const worktree = createWorktree(task.externalId || task.id, task.repo);
  const stack = loadStack({
    taskId: task.externalId || task.id,
    product: task.product,
    config: task.stack,
    extendedThinking: env.PLYNE_EXTENDED_THINKING && isExtendedThinkingEffort(task.effort),
    model: env.PLYNE_CLAUDE_MODEL
  });

  logger.info(
    { taskId: task.externalId, cwd: worktree.cwd, branch: worktree.branch, stack: stack.summary },
    "executor: spawning claude"
  );

  const prompt = buildPrompt(task, worktree.branch);
  // Run in non-interactive print mode so we can capture stdout deterministically.
  const args = ["-p", "--output-format", "text", ...stack.cliArgs];

  // Strip ANTHROPIC_API_KEY from the child env: when it is set (and
  // invalid / expired) claude CLI rejects with "Invalid API key" instead
  // of falling back to the user's OAuth Max session in ~/.claude/. On
  // scorta + Hetzner we rely on OAuth Max, so the right move is to
  // simply not propagate the env var at all. GH_TOKEN stays in childEnv so
  // the runner can reuse it for `git push` + `gh pr create`.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv["ANTHROPIC_API_KEY"];

  return new Promise<ExecutionResult>((resolve) => {
    const child = spawn(env.CLAUDE_CLI_PATH, args, {
      cwd: worktree.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdin.write(prompt);
    child.stdin.end();

    child.on("close", (code) => {
      stack.cleanup();
      const result: ExecutionResult = {
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        stackSummary: stack.summary,
        worktreeCwd: worktree.cwd,
        branch: worktree.branch,
        sourceRepoPath: worktree.sourceRepoPath,
        worktreeDestroy: worktree.destroy,
        childEnv
      };
      logger.info(
        { taskId: task.externalId, exitCode: result.exitCode, ms: result.durationMs },
        "executor: claude exited"
      );
      resolve(result);
    });

    child.on("error", (err) => {
      stack.cleanup();
      worktree.destroy();
      logger.error({ taskId: task.externalId, err }, "executor: spawn error");
      resolve({
        exitCode: -1,
        stdout: "",
        stderr: String(err),
        durationMs: Date.now() - started,
        stackSummary: stack.summary,
        worktreeCwd: worktree.cwd,
        branch: worktree.branch,
        sourceRepoPath: worktree.sourceRepoPath,
        worktreeDestroy: () => {
          /* already destroyed */
        },
        childEnv
      });
    });
  });
}
