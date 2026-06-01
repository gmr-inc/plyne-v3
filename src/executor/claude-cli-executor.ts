/**
 * Claude CLI executor — spawns the `claude` CLI with a prompt + stack loaded.
 *
 * v2 had a 53k-byte file handling 12 marker types, fix-forward loops, attempt
 * retries, validator post-mortems. v3 is a single `spawn → wait → return
 * exit code + stdout + stderr`. Markers are not Plyne's job; Claude's own
 * tools handle file writes / PR creation / Notion updates.
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
}

function isExtendedThinkingEffort(effort: Task["effort"]): boolean {
  // Architecture §"Model selection": extended thinking on M/L/XL only.
  return effort === "M" || effort === "L" || effort === "XL";
}

function buildPrompt(task: Task): string {
  // Plyne v3 prompt is intentionally minimal — Claude has its own hands
  // (MCP + Skills) and reads CLAUDE.md from the worktree. We feed it the
  // task contract verbatim.
  return [
    `# Task: ${task.externalId} — ${task.title}`,
    "",
    `**Product:** ${task.product}`,
    `**Repo:** ${task.repo}`,
    `**Effort:** ${task.effort ?? "unknown"}`,
    `**Notion page id:** ${task.id}`,
    "",
    "## Instructions",
    task.instructions || "(no instructions provided)",
    "",
    "## Acceptance Criteria",
    task.acceptanceCriteria || "(no AC provided)",
    "",
    "## How to report",
    "When done, write a file `PLYNE_V3_DONE.txt` in the current working",
    "directory containing a one-line summary. Plyne v3 monitors that marker",
    "to flip the Notion task to `done`. If you cannot finish, write",
    "`PLYNE_V3_BLOCKED.txt` instead with a one-line reason."
  ].join("\n");
}

export async function executeTask(task: Task): Promise<ExecutionResult> {
  const started = Date.now();
  const worktree = createWorktree(task.externalId || task.id);
  const stack = loadStack({
    taskId: task.externalId || task.id,
    product: task.product,
    config: task.stack,
    extendedThinking: env.PLYNE_EXTENDED_THINKING && isExtendedThinkingEffort(task.effort),
    model: env.PLYNE_CLAUDE_MODEL
  });

  logger.info(
    { taskId: task.externalId, cwd: worktree.cwd, stack: stack.summary },
    "executor: spawning claude"
  );

  const prompt = buildPrompt(task);
  // Run in non-interactive print mode so we can capture stdout deterministically.
  // The `-p` (print) flag accepts a prompt arg; we pass it via stdin instead
  // to avoid arg-length / shell-escape pitfalls.
  const args = ["-p", "--output-format", "text", ...stack.cliArgs];

  return new Promise<ExecutionResult>((resolve) => {
    const child = spawn(env.CLAUDE_CLI_PATH, args, {
      cwd: worktree.cwd,
      env: {
        ...process.env,
        // Pass the chosen model via env too, belt-and-suspenders.
        ANTHROPIC_MODEL: task.stack.model ?? env.PLYNE_CLAUDE_MODEL
      },
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
        stackSummary: stack.summary
      };
      logger.info(
        { taskId: task.externalId, exitCode: result.exitCode, ms: result.durationMs },
        "executor: claude exited"
      );
      // Worktree is NOT auto-destroyed — the runner inspects it for the
      // PLYNE_V3_DONE.txt / PLYNE_V3_BLOCKED.txt markers before cleanup.
      // Caller is responsible for calling worktree.destroy() afterwards.
      (result as ExecutionResult & { worktreeCwd: string }).worktreeCwd = worktree.cwd;
      (result as ExecutionResult & { worktreeDestroy: () => void }).worktreeDestroy = worktree.destroy;
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
        stackSummary: stack.summary
      });
    });
  });
}
