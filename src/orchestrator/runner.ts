/**
 * Plyne v3 runner — single cycle: pollReadyTasks → claim → execute → update.
 *
 * v2's runner.ts was 4641 LoC with 30+ orchestrator subsystems
 * (merge-loop, sprint-planner, sequencer, cap-enforcer, blast-radius,
 * postmortem, trust-tier, …). v3 deletes all of that.
 *
 * Why so small? Because the architecture pivot is: "Plyne does NOT play
 * autonomous CTO. Plyne hands a well-specced task to Claude Code (which
 * has MCP + Skills + memory of its own) and watches the result." The
 * intelligence lives in Claude + the task spec, not in Plyne.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadEnv } from "../config/env.js";
import { logger } from "../config/logger.js";
import { listReadyTasks, setStatus, addComment, type Task } from "../notion/client.js";
import { executeTask, type ExecutionResult } from "../executor/claude-cli-executor.js";

const env = loadEnv();

const inFlight = new Set<string>();

interface ExecutionResultExt extends ExecutionResult {
  worktreeCwd?: string;
  worktreeDestroy?: () => void;
}

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

    const result = (await executeTask(task)) as ExecutionResultExt;
    const cwd = result.worktreeCwd;
    const markers = cwd ? inspectMarkers(cwd) : { status: "unknown" as const, note: "" };

    const commentLines = [
      `**Plyne v3 execution complete**`,
      ``,
      `- exit code: \`${result.exitCode}\``,
      `- duration: \`${result.durationMs}ms\``,
      `- stack: \`${result.stackSummary}\``,
      `- marker: \`${markers.status}\``,
      markers.note ? `- note: ${markers.note}` : "",
      ``,
      result.stderr ? `**stderr (last 500 chars):**\n\n\`\`\`\n${result.stderr.slice(-500)}\n\`\`\`` : ""
    ].filter(Boolean);
    await addComment(task.id, commentLines.join("\n"));

    if (result.exitCode === 0 && markers.status === "done") {
      await setStatus(task.id, "done");
    } else if (markers.status === "blocked") {
      await setStatus(task.id, "needs-operator");
    } else if (result.exitCode === 0) {
      // Claude exited clean but didn't write a marker — operator decides.
      await setStatus(task.id, "needs-operator");
    } else {
      await setStatus(task.id, "needs-operator");
    }

    if (result.worktreeDestroy) result.worktreeDestroy();
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
