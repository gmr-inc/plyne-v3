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
import {
  listReadyTasks,
  setStatus,
  addComment,
  isNotionAuthError,
  type Task,
  type TaskStatus
} from "../notion/client.js";
import { executeTask } from "../executor/claude-cli-executor.js";
import { pushAndOpenPR, type PushPrResult } from "../executor/git-push-pr.js";
import {
  runAcceptanceCriteria,
  renderAcResultsMarkdown,
  type AcRunOutcome
} from "../executor/ac-runner.js";
import { formatEscalationReason, type EscalationReason } from "./escalation-reason.js";
import { getEventBus, type ActivityEventType } from "../lib/event-bus.js";
import { notify } from "../lib/notifications-writer.js";
import { writeQuotaSnapshot } from "../lib/supabase-reporter.js";
import { getMaxUsage } from "../usage/max-usage.js";
import { AutoPauseGate, isLimitHit } from "../usage/auto-pause.js";
import { captureException, captureMessage } from "../observability/sentry.js";
import { logExecutorRun } from "../observability/braintrust.js";

const env = loadEnv();
const bus = getEventBus();

/**
 * Claude Max auto-pause gate. Read once per cycle BEFORE dispatch. Thresholds
 * come from env (weekly default 90%, session default 95%). Best-effort: when
 * the usage reader returns null the gate does NOT pause (it proceeds + warns),
 * so a dark usage signal can never block the daemon.
 */
const pauseGate = new AutoPauseGate({
  weeklyPausePct: env.PLYNE_V3_WEEKLY_PAUSE_PCT,
  sessionPausePct: env.PLYNE_V3_SESSION_PAUSE_PCT,
  // Smart pacing: proactively queue task claims when the weekly burn rate is
  // projected to exhaust the Max allowance before it resets. Soft/self-healing,
  // and strictly subordinate to the hard caps above + the reactive backstop.
  pacing: {
    enabled: env.PLYNE_V3_PACING_ENABLED,
    minElapsedFrac: env.PLYNE_V3_PACING_MIN_ELAPSED_FRAC,
    marginPct: env.PLYNE_V3_PACING_MARGIN_PCT
  }
});

/** Emit the operator bell when the gate enters a pause episode. Best-effort. */
function notifyPauseEntered(d: { window?: string; pct?: number; resumeAt: number; reason?: string }): void {
  const pctTxt = d.pct !== undefined ? `${Math.round(d.pct)}%` : "cap";
  void notify({
    kind: "daemon_alert",
    severity: "warn",
    task_id: `auto_pause:${d.window ?? "limit"}`,
    task_name: "Plyne Max auto-pause",
    body: `Plyne in pausa — Max al ${pctTxt}. ${d.reason ?? ""} Riprende ~${new Date(d.resumeAt).toISOString()}.`.trim(),
    metadata: {
      window: d.window ?? "limit_hit",
      pct: d.pct ?? null,
      reason: d.reason ?? null,
      resume_at: new Date(d.resumeAt).toISOString()
    }
  });
}

/**
 * Push the latest Max usage to the plyne-app `claude_quota_snapshots` table so
 * the FE quota card shows live numbers. Best-effort; bypasses the reader cache
 * so the surfaced snapshot is fresh on its own cadence.
 */
async function pushQuotaSnapshot(): Promise<void> {
  try {
    const usage = await getMaxUsage({ force: true });
    if (!usage) return;
    await writeQuotaSnapshot(usage.sessionPct, usage.weeklyPct, {
      weekResetsAt: usage.weekResetsAt,
      sessionResetsAt: usage.sessionResetsAt
    });
  } catch (err) {
    logger.warn({ err }, "runner: quota snapshot push failed (ignored)");
  }
}

const QUOTA_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
let _quotaTimer: NodeJS.Timeout | undefined;

/**
 * Centralized SSE event emitter — keeps the shape consistent (task id,
 * truncated title, repo) across every lifecycle hook and prevents drift
 * between event types.
 *
 * Failure handling: emitActivity is in-process and synchronous; the only
 * realistic crash path is a listener throwing. Never let that take down the
 * runner — log warn and continue. A dark dashboard is strictly less bad
 * than a stopped daemon mid-task.
 */
function emitActivity(
  task: Task,
  event_type: ActivityEventType,
  details: Record<string, unknown> = {}
): void {
  try {
    bus.emitActivity({
      event_type,
      task_id: task.id,
      task_name: (task.title ?? "").slice(0, 200) || "(untitled)",
      task_repo: task.repo || "(unknown)",
      details
    });
  } catch (err) {
    logger.warn({ err, event_type, taskId: task.externalId }, "runner: emitActivity failed");
  }
}

const inFlight = new Set<string>();

/**
 * Count of tasks currently claiming/executing. Read by the Supabase heartbeat
 * reporter (src/lib/supabase-reporter.ts) so the dashboard shows live load.
 */
export function getInFlightCount(): number {
  return inFlight.size;
}

/**
 * Circuit breaker: if the polling cycle gets a Notion 401 N times in a row
 * (token rotated mid-run, workspace scope dropped, etc.), stop the runner
 * loop entirely. Hardcoded threshold — we'd rather hold than spam 401s every
 * 15s forever. Operator sees the runner stop in logs + pm2 surfacing healthy
 * process (HTTP API still up for /health), then can rotate the token and
 * `pm2 restart plyne-v3`.
 *
 * Tested against the 2026-06-02 incident pattern: a revoked token used to
 * burn ~1900 cycles in 2h. With this gate, it now burns 5.
 */
const MAX_CONSECUTIVE_AUTH_ERRORS = 5;
let consecutiveAuthErrors = 0;

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

/**
 * One-line statement of what the agent set out to do — the task goal — for the
 * human-oriented escalation reason. Prefer the task title (its Description),
 * fall back to the external id.
 */
function taskGoalLine(task: Task): string {
  return (task.title || task.externalId || "(untitled task)").slice(0, 200);
}

/**
 * Persist a structured, human-oriented escalation reason onto the task while
 * setting an escalation status. Wraps setStatus with the rendered reason so the
 * console's LLM layer can explain (in plain language) WHY a human is needed.
 * Status write is defensive (see notion.setStatus): a missing status option
 * falls back to needs-rework/needs-operator while still writing the reason.
 */
async function escalate(task: Task, status: TaskStatus, reason: EscalationReason): Promise<void> {
  await setStatus(task.id, status, { reason: formatEscalationReason(reason) });
}

async function processOne(task: Task): Promise<void> {
  if (inFlight.has(task.id)) return;
  inFlight.add(task.id);
  try {
    logger.info({ taskId: task.externalId }, "runner: claim");
    emitActivity(task, "task.picked", { external_id: task.externalId });
    await setStatus(task.id, "claiming");
    await setStatus(task.id, "executing");
    emitActivity(task, "task.executor.started", { external_id: task.externalId });

    const result = await executeTask(task);

    // ── Braintrust baseline "Agent Health" logging ───────────────────────
    // Log every Claude executor invocation (input / output / latency / exit
    // code) so eval datasets can be built later. Best-effort + no-op when
    // BRAINTRUST_API_KEY is unset; never throws into the runner. We log the raw
    // run here; the post-execution disposition (PR / AC / blocked) is summarised
    // in the outcome field once known below — logging now guarantees we capture
    // the call even if downstream throws.
    logExecutorRun(
      {
        taskId: task.id,
        externalId: task.externalId,
        product: task.product,
        repo: task.repo,
        effort: task.effort ?? undefined,
        model: env.PLYNE_CLAUDE_MODEL
      },
      {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stackSummary: result.stackSummary,
        stdout: result.stdout,
        stderr: result.stderr,
        branch: result.branch
      }
    );

    // ── Reactive backstop ────────────────────────────────────────────────
    // If the claude CLI itself reported a usage/rate limit (its own strings),
    // the proactive % gate lagged. Immediately arm the pause gate AND re-queue
    // this task back to `ready` (NOT failed) so it retries after the window
    // resets — one limit-hit stops the hammering instead of burning the task.
    if (isLimitHit(result.stdout) || isLimitHit(result.stderr)) {
      logger.warn(
        { taskId: task.externalId },
        "runner: claude reported a usage/rate limit — re-queuing task + arming auto-pause backstop"
      );
      // resets_at: prefer a fresh usage read so we resume at the real window
      // reset; fall back to the gate's 30-min default when usage is unavailable.
      let resetsAt: string | null = null;
      try {
        const u = await getMaxUsage();
        resetsAt = (u?.weekly.resetsAt ?? u?.session.resetsAt) ?? null;
      } catch {
        /* best-effort */
      }
      pauseGate.forcePauseFromLimitHit(resetsAt, notifyPauseEntered);
      try {
        // Re-queue for retry after reset. Cleanup the worktree — the next
        // attempt carves a fresh one.
        await setStatus(task.id, "ready");
        await addComment(
          task.id,
          "Plyne v3 hit a Claude usage/rate limit mid-execution. Task re-queued to `ready` and " +
            "dispatch paused until the Max window resets — it will retry automatically."
        );
      } catch (err) {
        logger.warn({ taskId: task.externalId, err }, "runner: re-queue after limit-hit failed");
      }
      emitActivity(task, "task.escalated", { external_id: task.externalId, reason: "usage_limit_hit" });
      try {
        result.worktreeDestroy();
      } catch {
        /* ignore */
      }
      return;
    }

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
    let acOutcome: AcRunOutcome | null = null;
    let acBlocked = false;

    // Open a PR if (a) we have a real git worktree, (b) Claude did not
    // explicitly self-block. Done-marker is preferred but optional: if
    // Claude forgot the marker but produced a diff, we still want the PR.
    if (result.branch && markers.status !== "blocked") {
      // ── AC GATE ──────────────────────────────────────────────────────
      // Machine-verify the task's executable Acceptance Criteria in the SAME
      // worktree/env Claude used, BEFORE opening the PR. This is what makes
      // auto-merge safe: by pr-open the AC have already passed, so the merge
      // gate only needs CI + CodeRabbit.
      //
      // Best-effort: an internal AC-runner error must never crash the daemon.
      // On internal error we fall back to today's behaviour (open the PR) and
      // log — the AC runner deliberately never throws, but we wrap anyway.
      try {
        acOutcome = runAcceptanceCriteria(
          task.acceptanceCriteria,
          result.worktreeCwd,
          result.childEnv
        );
      } catch (err) {
        logger.error(
          { taskId: task.externalId, err },
          "runner: AC runner threw (falling back to open-PR-anyway)"
        );
        acOutcome = null;
      }

      if (acOutcome && acOutcome.status === "fail") {
        // AC FAILED → do NOT open the PR / do NOT mark success. Escalate.
        acBlocked = true;
        logger.warn(
          { taskId: task.externalId, failing: acOutcome.checks.filter((c) => !c.pass).length },
          "runner: AC verification failed — withholding PR, escalating to operator"
        );
      } else {
        const acBody = acOutcome ? renderAcResultsMarkdown(acOutcome) : undefined;
        try {
          pr = await pushAndOpenPR(task, result.worktreeCwd, result.branch, result.childEnv, acBody);
        } catch (err) {
          prError = String(err).slice(0, 400);
          logger.error({ taskId: task.externalId, err }, "runner: pushAndOpenPR threw");
        }
      }
    }

    // Update Notion: pr-open wins, else needs-operator (we deliberately drop
    // the old "done from marker alone" path — a task with no PR is not done).
    if (pr) {
      await setStatus(task.id, "pr-open", pr.prUrl);
      // SSE first (dashboard real-time), notifications-writer after (bell + Notion routing).
      emitActivity(task, "task.pr.opened", {
        external_id: task.externalId,
        pr_url: pr.prUrl,
        branch: pr.branch,
        commit_sha: pr.commitSha
      });
      // task.done as a separate event so the UI can render a completion
      // bullet distinct from the PR-opened one (operator may want to see
      // both — "PR opened" + "task closed by Plyne").
      emitActivity(task, "task.done", { external_id: task.externalId, pr_url: pr.prUrl });
      // pr_opened — broadcast (owner_user_id null) so all admins see the PR
      // in their bell. Per-PO routing can layer on top later via task owner.
      void notify({
        kind: "pr_opened",
        severity: "info",
        task_id: task.id,
        task_name: task.title || task.externalId,
        body: `PR opened for ${task.externalId}: ${pr.prUrl}`,
        metadata: {
          external_id: task.externalId,
          pr_url: pr.prUrl,
          branch: pr.branch,
          commit_sha: pr.commitSha,
          product: task.product,
          repo: task.repo
        }
      });
    } else if (acBlocked && acOutcome) {
      // AC verification failed: PR withheld, hand to a human.
      const failing = acOutcome.checks.filter((c) => !c.pass);
      // Capture WHY onto the task (CTO Feedback) so the console can explain it.
      // needs-revision = "the code Plyne wrote doesn't meet the AC, revise it"
      // (defensively falls back to needs-rework/needs-operator if the board
      // lacks that status option).
      await escalate(task, "needs-revision", {
        attempted: taskGoalLine(task),
        outcome: "acceptance_criteria_failed",
        totalChecks: acOutcome.checks.length,
        failingChecks: failing.map((c) => ({
          command: c.command,
          expectedExit: c.expectedExit,
          actualExit: c.actualExit,
          spawnError: c.spawnError
        })),
        keyError: result.stderr ? result.stderr.slice(-200) : undefined
      });
      const acFailMd = [
        `**Plyne v3 withheld the PR — Acceptance Criteria failed.**`,
        ``,
        `The executable AC were run in the task worktree before opening a PR. ` +
          `${failing.length} of ${acOutcome.checks.length} failed:`,
        ``,
        ...failing.map(
          (c) =>
            `- \`${c.command}\` → ${
              c.spawnError ? `error: ${c.spawnError}` : `expected exit ${c.expectedExit}, got ${c.actualExit}`
            }`
        ),
        ``,
        `No PR was opened. Fix the AC (or the code) and re-run.`
      ].join("\n");
      try {
        await addComment(task.id, acFailMd);
      } catch (err) {
        logger.warn({ taskId: task.externalId, err }, "runner: AC-fail comment failed");
      }
      emitActivity(task, "task.escalated", {
        external_id: task.externalId,
        reason: "ac_failed",
        failing: failing.map((c) => c.command)
      });
      void notify({
        kind: "task_failed",
        severity: "warn",
        task_id: task.id,
        task_name: task.title || task.externalId,
        body: `Task ${task.externalId} AC failed (${failing.length}/${acOutcome.checks.length}) — PR withheld`,
        metadata: {
          external_id: task.externalId,
          reason: "ac_failed",
          failing: failing.map((c) => `${c.command} (got ${c.actualExit}, want ${c.expectedExit})`),
          product: task.product
        }
      });
    } else if (markers.status === "blocked") {
      // Claude self-blocked (hard tech blocker it couldn't resolve). needs-rework
      // = "Plyne hit a wall, a human needs to unblock" (defensive fallback to
      // needs-operator if that option is absent).
      await escalate(task, "needs-rework", {
        attempted: taskGoalLine(task),
        outcome: "self_blocked",
        keyError: markers.note || (result.stderr ? result.stderr.slice(-200) : undefined)
      });
      emitActivity(task, "task.escalated", {
        external_id: task.externalId,
        reason: "self_blocked",
        note: markers.note
      });
      void notify({
        kind: "task_failed",
        severity: "warn",
        task_id: task.id,
        task_name: task.title || task.externalId,
        body: `Task ${task.externalId} self-blocked: ${markers.note || "no reason given"}`,
        metadata: {
          external_id: task.externalId,
          marker: markers.status,
          marker_note: markers.note,
          pr_error: prError,
          product: task.product
        }
      });
    } else {
      // Either pushAndOpenPR threw (hard tech blocker on the git/PR step) or no
      // diff was produced (no PR). Capture the distinction + the key error.
      await escalate(task, "needs-operator", {
        attempted: taskGoalLine(task),
        outcome: prError ? "hard_tech_blocker" : "no_pr_produced",
        keyError: prError || (result.stderr ? result.stderr.slice(-200) : undefined)
      });
      emitActivity(task, "task.failed", {
        external_id: task.externalId,
        pr_error: prError,
        exit_code: result.exitCode,
        marker: markers.status
      });
      void notify({
        kind: "task_failed",
        severity: prError ? "error" : "warn",
        task_id: task.id,
        task_name: task.title || task.externalId,
        body: prError
          ? `Task ${task.externalId} failed to open PR: ${prError}`
          : `Task ${task.externalId} completed without a PR (no diff produced)`,
        metadata: {
          external_id: task.externalId,
          marker: markers.status,
          pr_error: prError,
          exit_code: result.exitCode,
          product: task.product
        }
      });
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
      acOutcome
        ? `- AC: \`${acOutcome.status}\` (${acOutcome.checks.filter((c) => c.pass).length}/${acOutcome.checks.length} passed)`
        : `- AC: _not run_`,
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
    // Report per-task runner exceptions to Sentry with task context. These are
    // the unexpected failures the daemon previously only logged locally.
    captureException(err, {
      phase: "runner_processOne",
      taskId: task.id,
      externalId: task.externalId,
      product: task.product,
      repo: task.repo
    });
    emitActivity(task, "task.failed", {
      external_id: task.externalId,
      reason: "runner_exception",
      error: String(err).slice(0, 300)
    });
    try {
      await escalate(task, "needs-operator", {
        attempted: taskGoalLine(task),
        outcome: "runner_exception",
        keyError: String(err).slice(0, 280)
      });
      await addComment(task.id, `Plyne v3 crashed processing this task:\n\n\`\`\`\n${String(err).slice(0, 1500)}\n\`\`\``);
    } catch {
      /* swallow — Notion outages must not crash the daemon */
    }
    void notify({
      kind: "task_failed",
      severity: "error",
      task_id: task.id,
      task_name: task.title || task.externalId,
      body: `Plyne v3 crashed processing ${task.externalId}: ${String(err).slice(0, 300)}`,
      metadata: {
        external_id: task.externalId,
        product: task.product,
        error: String(err).slice(0, 1500)
      }
    });
  } finally {
    inFlight.delete(task.id);
  }
}

async function cycle(): Promise<void> {
  if (inFlight.size >= env.MAX_CONCURRENT_TASKS) return;

  // ── Claude Max auto-pause gate ───────────────────────────────────────────
  // Read live Max utilization and decide whether to dispatch this cycle. If
  // weekly% >= PLYNE_V3_WEEKLY_PAUSE_PCT or session% >= PLYNE_V3_SESSION_PAUSE_PCT
  // we skip dispatch and set an internal pausedUntil = the window's resets_at,
  // auto-resuming once the window resets and usage drops below the cap. The
  // usage read + the gate are BEST-EFFORT — a null reading proceeds + warns,
  // and nothing here throws into the daemon hot path.
  const usage = await getMaxUsage();
  if (!usage) {
    logger.warn("runner: Max usage unavailable this cycle — proceeding without auto-pause gate");
  }
  const { dispatch } = pauseGate.evaluate(usage, notifyPauseEntered);
  if (!dispatch) {
    logger.warn(
      {
        weeklyPct: usage?.weeklyPct ?? null,
        sessionPct: usage?.sessionPct ?? null,
        resumeAt: pauseGate.pausedUntilMs() ? new Date(pauseGate.pausedUntilMs()!).toISOString() : null
      },
      "runner: dispatch paused (Max usage gate) — skipping task dispatch this cycle"
    );
    return;
  }

  const slots = env.MAX_CONCURRENT_TASKS - inFlight.size;
  let tasks: Task[];
  try {
    tasks = await listReadyTasks(env.PLYNE_V3_TASK_PREFIX, slots);
  } catch (err) {
    if (isNotionAuthError(err)) {
      consecutiveAuthErrors += 1;
      logger.error(
        { consecutiveAuthErrors, threshold: MAX_CONSECUTIVE_AUTH_ERRORS },
        "runner: Notion auth error during poll — counting toward circuit breaker"
      );
      if (consecutiveAuthErrors >= MAX_CONSECUTIVE_AUTH_ERRORS) {
        logger.fatal(
          { consecutiveAuthErrors },
          "runner: circuit breaker tripped — stopping runner. Rotate NOTION_TOKEN and `pm2 restart plyne-v3`."
        );
        // SURFACE the runtime cousin of the crash-loop: a revoked token used to
        // burn ~1900 cycles silently. The breaker now stops at 5 — report that
        // trip to Sentry so on-call sees it without grepping pm2 logs.
        captureMessage("plyne-v3 runner circuit breaker tripped (Notion auth)", "fatal", {
          phase: "runner_circuit_breaker",
          consecutiveAuthErrors,
          recovery: "rotate NOTION_TOKEN + pm2 restart plyne-v3"
        });
        // task_escalated: broadcast to all admins. Use a synthetic task_id
        // so dedupe collapses storm conditions to a single bell entry per
        // 5-min window per the writer contract.
        void notify({
          kind: "task_escalated",
          severity: "error",
          task_id: "circuit_breaker:notion_auth",
          task_name: "Notion auth circuit breaker",
          body: `Plyne v3 runner stopped — ${consecutiveAuthErrors} consecutive Notion 401s. Rotate NOTION_TOKEN and \`pm2 restart plyne-v3\`.`,
          metadata: {
            consecutive_errors: consecutiveAuthErrors,
            threshold: MAX_CONSECUTIVE_AUTH_ERRORS,
            recovery: "rotate NOTION_TOKEN + pm2 restart plyne-v3"
          }
        });
        stopRunner();
      }
      return;
    }
    // Non-auth errors (timeouts, socket hang up) — log and try again next tick.
    throw err;
  }
  // Successful poll → reset the auth-error counter.
  if (consecutiveAuthErrors > 0) {
    logger.info(
      { previousCount: consecutiveAuthErrors },
      "runner: Notion auth recovered — resetting circuit breaker"
    );
    consecutiveAuthErrors = 0;
  }
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

  // Surface Max usage on the dashboard quota card: push one snapshot now, then
  // every ~5 min. Best-effort + self-gated (no-ops when usage read or the
  // plyne-app Supabase client is unavailable). unref so it never holds the loop.
  void pushQuotaSnapshot();
  _quotaTimer = setInterval(() => void pushQuotaSnapshot(), QUOTA_SNAPSHOT_INTERVAL_MS);
  _quotaTimer.unref?.();

  const tick = async () => {
    if (stopped) return;
    try {
      await cycle();
    } catch (err) {
      logger.error({ err }, "runner: cycle threw");
      captureException(err, { phase: "runner_cycle" });
    } finally {
      if (!stopped) timer = setTimeout(tick, env.POLL_INTERVAL_MS);
    }
  };
  void tick();
}

export function stopRunner(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  if (_quotaTimer) {
    clearInterval(_quotaTimer);
    _quotaTimer = undefined;
  }
}
