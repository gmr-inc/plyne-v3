/**
 * Auto-pause gate — decides whether the runner should skip dispatching tasks
 * this cycle based on live Claude Max usage, and tracks an auto-resume time.
 *
 * Why: a Claude Max session has a weekly allowance. If Plyne keeps dispatching
 * after the weekly window is exhausted, every `claude` invocation 429s and the
 * daemon just hammers a dead cap for the rest of the week. This gate stops
 * dispatch once weekly% (or the tighter 5h session%) crosses a threshold, and
 * auto-resumes once the relevant window has reset.
 *
 * Decision rules (see decidePause):
 *   - usage === null (reader failed) → DO NOT pause (proceed + warn upstream).
 *     Never block the daemon on a best-effort reader.
 *   - weeklyPct  >= weeklyPausePct  → pause until seven_day.resets_at
 *   - sessionPct >= sessionPausePct → pause until five_hour.resets_at
 *   (weekly takes precedence when both trip — it's the longer wall.)
 *
 * The gate is a tiny stateful object so the runner can call shouldDispatch()
 * once per cycle. State: pausedUntil (ms epoch) + which window tripped. All
 * pure/synchronous — the async usage read happens in the runner and is passed
 * in, keeping this unit-testable without network/fs.
 */
import { logger } from "../config/logger.js";
import type { MaxUsage } from "./max-usage.js";

export interface PauseThresholds {
  weeklyPausePct: number;
  sessionPausePct: number;
}

export type PauseWindow = "weekly" | "session";

export interface PauseDecision {
  pause: boolean;
  /** Which window tripped the gate (only when pause=true). */
  window?: PauseWindow;
  /** The utilization % that tripped it (only when pause=true). */
  pct?: number;
  /** ISO resets_at of the tripped window, or null when the response lacked it. */
  resetsAt?: string | null;
  /** Human reason (also used in the notify body). */
  reason?: string;
}

/**
 * Pure decision: given a usage reading (or null) + thresholds, should we pause?
 * Exported for unit tests.
 */
export function decidePause(usage: MaxUsage | null, thresholds: PauseThresholds): PauseDecision {
  // Reader failed → never pause. Best-effort: a dark usage signal must not
  // block the daemon.
  if (!usage) return { pause: false };

  if (usage.weeklyPct >= thresholds.weeklyPausePct) {
    return {
      pause: true,
      window: "weekly",
      pct: usage.weeklyPct,
      resetsAt: usage.weekly.resetsAt,
      reason: `weekly Max usage ${usage.weeklyPct}% >= ${thresholds.weeklyPausePct}%`
    };
  }
  if (usage.sessionPct >= thresholds.sessionPausePct) {
    return {
      pause: true,
      window: "session",
      pct: usage.sessionPct,
      resetsAt: usage.session.resetsAt,
      reason: `5h session Max usage ${usage.sessionPct}% >= ${thresholds.sessionPausePct}%`
    };
  }
  return { pause: false };
}

/**
 * Parse a resets_at ISO string into an epoch-ms resume time. Falls back to
 * `now + fallbackMs` when the timestamp is missing/unparseable so a paused
 * daemon always has a finite resume horizon (never stuck paused forever on a
 * malformed response).
 */
export function resolveResumeAt(resetsAt: string | null | undefined, now: number, fallbackMs: number): number {
  if (resetsAt) {
    const t = Date.parse(resetsAt);
    if (Number.isFinite(t) && t > now) return t;
  }
  return now + fallbackMs;
}

// When resets_at is unusable, retry in 30 min rather than pausing indefinitely.
const FALLBACK_RESUME_MS = 30 * 60 * 1000;

/**
 * Stateful gate the runner holds across cycles. `onEnterPause` fires exactly
 * once per pause episode (entering, not every blocked cycle) so the operator
 * gets one bell, not a storm.
 */
export class AutoPauseGate {
  private pausedUntil: number | null = null;
  private pausedWindow: PauseWindow | null = null;

  constructor(
    private readonly thresholds: PauseThresholds,
    private readonly now: () => number = Date.now
  ) {}

  isPaused(): boolean {
    return this.pausedUntil !== null;
  }

  pausedUntilMs(): number | null {
    return this.pausedUntil;
  }

  /**
   * Evaluate the gate for this cycle. Returns whether the runner may dispatch.
   *
   * @param usage      the live usage reading (or null when the reader failed)
   * @param onEnterPause called once when transitioning idle → paused
   * @returns dispatch=true → runner proceeds to listReadyTasks; false → skip.
   */
  evaluate(
    usage: MaxUsage | null,
    onEnterPause?: (d: PauseDecision & { resumeAt: number }) => void
  ): { dispatch: boolean; decision: PauseDecision } {
    const now = this.now();

    // Already paused → check for auto-resume. Require a fresh reading that
    // dropped BELOW threshold before resuming; if usage is still at/above
    // threshold (or null) keep waiting / re-arm pausedUntil.
    if (this.pausedUntil !== null) {
      if (now < this.pausedUntil) {
        const decision: PauseDecision = { pause: true };
        if (this.pausedWindow) decision.window = this.pausedWindow;
        return { dispatch: false, decision };
      }
      // resume horizon reached — re-confirm with the current reading.
      const recheck = decidePause(usage, this.thresholds);
      if (recheck.pause) {
        // still over the cap → push the horizon out again and stay paused.
        this.pausedUntil = resolveResumeAt(recheck.resetsAt, now, FALLBACK_RESUME_MS);
        this.pausedWindow = recheck.window ?? this.pausedWindow;
        logger.warn(
          { window: recheck.window, pct: recheck.pct, resumeAt: new Date(this.pausedUntil).toISOString() },
          "auto-pause: resume horizon reached but usage still over cap — staying paused"
        );
        return { dispatch: false, decision: recheck };
      }
      // dropped below cap (or reader failed but horizon elapsed) → resume.
      logger.info(
        { previousWindow: this.pausedWindow, weeklyPct: usage?.weeklyPct, sessionPct: usage?.sessionPct },
        "auto-pause: window reset and usage back under cap — resuming dispatch"
      );
      this.pausedUntil = null;
      this.pausedWindow = null;
      return { dispatch: true, decision: { pause: false } };
    }

    // Not currently paused → evaluate whether to enter pause.
    const decision = decidePause(usage, this.thresholds);
    if (!decision.pause) {
      return { dispatch: true, decision };
    }

    const resumeAt = resolveResumeAt(decision.resetsAt, now, FALLBACK_RESUME_MS);
    this.pausedUntil = resumeAt;
    this.pausedWindow = decision.window ?? null;
    logger.fatal(
      { window: decision.window, pct: decision.pct, resumeAt: new Date(resumeAt).toISOString(), reason: decision.reason },
      "auto-pause: ENTERING pause — Plyne will not dispatch tasks until the Max window resets"
    );
    if (onEnterPause) {
      try {
        onEnterPause({ ...decision, resumeAt });
      } catch (err) {
        logger.warn({ err }, "auto-pause: onEnterPause callback threw (ignored)");
      }
    }
    return { dispatch: false, decision };
  }

  /**
   * Reactive backstop: a `claude` invocation reported a usage/rate limit. Force
   * the gate into a pause without a fresh % reading (the proactive check lagged).
   * Idempotent-ish: only fires onEnterPause when transitioning idle → paused.
   */
  forcePauseFromLimitHit(
    resetsAt: string | null | undefined,
    onEnterPause?: (d: { resumeAt: number; reason: string }) => void
  ): void {
    const now = this.now();
    const resumeAt = resolveResumeAt(resetsAt, now, FALLBACK_RESUME_MS);
    const wasPaused = this.pausedUntil !== null;
    // extend (never shorten) the existing horizon.
    this.pausedUntil = Math.max(this.pausedUntil ?? 0, resumeAt);
    if (!this.pausedWindow) this.pausedWindow = "session";
    if (!wasPaused) {
      const reason = "claude invocation hit a usage/rate limit (reactive backstop)";
      logger.fatal(
        { resumeAt: new Date(this.pausedUntil).toISOString() },
        "auto-pause: reactive backstop tripped — a claude run hit a limit, pausing dispatch"
      );
      if (onEnterPause) {
        try {
          onEnterPause({ resumeAt: this.pausedUntil, reason });
        } catch (err) {
          logger.warn({ err }, "auto-pause: onEnterPause (backstop) callback threw (ignored)");
        }
      }
    }
  }
}

/**
 * Detect the Claude CLI's own usage/rate-limit strings in a process's combined
 * stdout/stderr. Used by the reactive backstop. Case-insensitive.
 */
export function isLimitHit(output: string | null | undefined): boolean {
  if (!output) return false;
  const s = output.toLowerCase();
  return s.includes("usage limit reached") || s.includes("rate limit");
}
