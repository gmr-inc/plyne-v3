/**
 * Plyne v3 runner — single cycle: pollReadyTasks → claim → execute →
 * commit + push + PR → update Notion.
 *
 * v2's runner.ts was 4641 LoC with 30+ orchestrator subsystems. v3 deletes
 * all of that. v3.1 adds back the one thing v3 stripped too aggressively:
 * the post-execution git workflow. Without it, Claude wrote orphan files
 * in a non-git temp dir and tasks were marked done with zero output.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { listReadyTasks, setStatus, addComment, type Task } from "../notion/client.js";
import { executeTask } from "../executor/claude-cli-executor.js";
import { pushAndOpenPR, type PushPrResult } from "../executor/git-push-pr.js";

const env = loadEnv();

const inFlight = new Set<string>();

/**
 * Read the done/blocked marker file Claude was instructed to write.
 * Returns the discovered terminal status + the marker file's contents.
 */
function inspectMarkers(cwd: string): { status: "done" | "blocked" | "unknown"; note: string } {
  try {
    const donePath = path.join(cwd, "PLYNE_V3_DONE.txt");
    if (fs.existsSync(donePath)) {
      return { status: "done", note: fs.readFileSync(donePath, "utf8").slice(0, 500).trim() };
    }
    const blockedPath = path.join(cwd, "PLYNE_V3_BLOCKED.txt");
    if (fs.existsSync(blockedPath)) {
      return { status: "blocked", note: fs.readFileSync(blockedPath, "utf8").slice(0, 500).trim() };
    }
  } catch (err) {
    logger.warn({ cwd, err }, "runner: marker inspection failed");
  }
  return { status: "unknown", note: "" };
}

async function processOne(task: Task): Promise<void> {
  if (inFlight.has(task.id)) return;
  inFlight.add(task.id);
  try {
    logger.info({ taskId: task.externalId }, "runner: claim");
    await setStatus(task.id, "claiming");
    await setStatus(task.id, "executing");

    const result = await executeTask(task);
    const markers = inspectMarkers(result.worktreeCwd);

    // Before reporting, also strip the marker files so they don't get
    // committed into the PR diff. They're Plyne signaling, not project code.
    for (const marker of ["PLYNE_V3_DONE.txt", "PLYNE_V3_BLOCKED.txt"]) {
      const p = path.join(result.worktreeCwd, marker);
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }

    let pr: PushPrResult | null = null;
    let prError: string | null = null;

    // Open a PR if (a) we have a real git worktree, (b) Claude did not
    // explicitly self-block. Done-marker is preferred but optional: if
    // Claude forgot the marker but produced a diff, we still want the PR.
    if (result.branch && markers.status !== "blocked") {
      try {
        pr = await pushAndOpenPR(task, result.worktreeCwd, result.branch, result.childEnv);
      } catch (err) {
        prError = String(err).slice(0, 400);
        logger.error({ taskId: task.externalId, err }, "runner: pushAndOpenPR threw");
      }
    }

    // Update Notion: pr-open wins, else needs-operator (we deliberately drop
    // the old "done from marker alone" path — a task with no PR is not done).
    if (pr) {
      await setStatus(task.id, "pr-open", pr.prUrl);
    } else if (markers.status === "blocked") {
      await setStatus(task.id, "needs-operator");
    } else {
      await setStatus(task.id, "needs-operator");
    }

    const commentLines = [
      `**Plyne v3 execution complete**`,
      ``,
      `- exit code: \`${result.exitCode}\``,
      `- duration: \`${result.durationMs}ms\``,
      `- stack: \`${result.stackSummary}\``,
      `- marker: \`${markers.status}\``,
      `- branch: \`${result.branch ?? "(scratch dir — no git)"}\``,
      pr ? `- PR: ${pr.prUrl} (\`${pr.commitSha.slice(0, 7)}\`)` : `- PR: _none_`,
      markers.note ? `- note: ${markers.note}` : "",
      prError ? `- pr error: ${prError}` : "",
      ``,
      result.stderr ? `**stderr (last 500 chars):**\n\n\`\`\`\n${result.stderr.slice(-500)}\n\`\`\`` : ""
    ].filter(Boolean);
    await addComment(task.id, commentLines.join("\n"));

    // Cleanup worktree only on success (PR opened). On failure, leave it so
    // operator can poke at it.
    if (pr) result.worktreeDestroy();
  } catch (err) {
    logger.error({ taskId: task.externalId, err }, "runner: processOne failed");
    try {
      await setStatus(task.id, "needs-operator");
      await addComment(task.id, `Plyne v3 crashed processing this task:\n\n\`\`\`\n${String(err).slice(0, 1500)}\n\`\`\``);
    } catch {
      /* swallow — Notion outages must not crash the daemon */
    }
  } finally {
    inFlight.delete(task.id);
  }
}

async function cycle(): Promise<void> {
  if (inFlight.size >= env.MAX_CONCURRENT_TASKS) return;
  const slots = env.MAX_CONCURRENT_TASKS - inFlight.size;
  const tasks = await listReadyTasks(env.PLYNE_V3_TASK_PREFIX, slots);
  if (tasks.length === 0) return;
  logger.info({ count: tasks.length, prefix: env.PLYNE_V3_TASK_PREFIX }, "runner: picked tasks");
  // Fire-and-forget per task; each manages its own status updates.
  for (const t of tasks) void processOne(t);
}

let stopped = false;
let timer: NodeJS.Timeout | undefined;

export function startRunner(): void {
  logger.info(
    {
      model: env.PLYNE_CLAUDE_MODEL,
      extendedThinking: env.PLYNE_EXTENDED_THINKING,
      pollMs: env.POLL_INTERVAL_MS,
      maxConcurrent: env.MAX_CONCURRENT_TASKS,
      prefix: env.PLYNE_V3_TASK_PREFIX
    },
    "runner: starting daemon"
  );
  const tick = async () => {
    if (stopped) return;
    try {
      await cycle();
    } catch (err) {
      logger.error({ err }, "runner: cycle threw");
    } finally {
      if (!stopped) timer = setTimeout(tick, env.POLL_INTERVAL_MS);
    }
  };
  void tick();
}

export function stopRunner(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
}
