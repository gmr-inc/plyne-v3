/**
 * Smart pacing — proactively spread the weekly Claude Max budget across the
 * whole 7-day window instead of only braking at a hard cap.
 *
 * The hard caps in auto-pause.ts (weekly>=90, session>=95) are absolute
 * backstops: they only fire once the allowance is nearly gone. By then a burst
 * of work early in the week can have already eaten the whole budget, leaving
 * the daemon dark for days until the weekly window resets.
 *
 * Pacing fixes that by comparing where usage SHOULD be (a linear budget across
 * the week) with where it IS, and extrapolating the current burn rate to the
 * end of the window. If we're projected to blow past 100% before the reset, we
 * pause new task claims so the budget is spread out. This pause is SOFT and
 * self-healing: as the week elapses `paceTargetPct` rises and `projectedEndPct`
 * falls, so dispatch auto-resumes the moment the burn rate becomes sustainable.
 *
 * This module is a PURE function of (weekUsedPct, now, weekResetsAt) — no I/O,
 * no clock reads of its own — so it is fully unit-testable.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface Pacing {
  /**
   * Fraction of the weekly window that has elapsed, clamped to [0,1].
   * windowStart = weekResetsAt - 7d; elapsedFrac = (now - windowStart) / 7d.
   */
  elapsedFrac: number;
  /**
   * Where usage "should" be today on a linear budget: elapsedFrac * 100.
   * (e.g. ~14% one day into the week.)
   */
  paceTargetPct: number;
  /**
   * Current burn rate extrapolated to the end of the window:
   * weekUsedPct / elapsedFrac. 0 when elapsedFrac is 0 (no signal yet).
   * >100 means we're projected to exhaust the weekly allowance before it resets.
   */
  projectedEndPct: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Compute the pacing snapshot for the weekly window.
 *
 * @param weekUsedPct  seven_day.utilization (whole-number percent, 0..100)
 * @param now          wall-clock ms (epoch)
 * @param weekResetsAt ISO-8601 ts the weekly window resets at (or null)
 *
 * When weekResetsAt is missing/unparseable we cannot locate the window, so we
 * return a neutral reading (elapsedFrac=0) — which never trips a pacing pause
 * (the gate requires elapsedFrac >= a minimum). Best-effort by construction.
 */
export function computePacing(weekUsedPct: number, now: number, weekResetsAt: string | null | undefined): Pacing {
  const used = Number.isFinite(weekUsedPct) ? weekUsedPct : 0;

  const resetMs = weekResetsAt ? Date.parse(weekResetsAt) : NaN;
  if (!Number.isFinite(resetMs)) {
    return { elapsedFrac: 0, paceTargetPct: 0, projectedEndPct: 0 };
  }

  const windowStart = resetMs - WEEK_MS;
  const elapsedFrac = clamp01((now - windowStart) / WEEK_MS);
  const paceTargetPct = elapsedFrac * 100;
  const projectedEndPct = elapsedFrac > 0 ? used / elapsedFrac : 0;

  return { elapsedFrac, paceTargetPct, projectedEndPct };
}
