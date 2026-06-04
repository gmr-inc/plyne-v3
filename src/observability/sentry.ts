/**
 * Self-observability — Sentry error reporting for the Plyne v3 daemon.
 *
 * THE GAP THIS CLOSES: plyne-v3 shipped with ZERO observability. When a
 * rotated/expired ANTHROPIC/NOTION credential or a bad boot check sent the
 * daemon into `process.exit(1)`, pm2 dutifully restarted it — ~1948 times —
 * and nobody knew, because the FATAL never left the box. This wires
 * `@sentry/node` so every uncaught exception, unhandled rejection AND the
 * crash-loop FATAL boot path surfaces to Sentry.
 *
 * Design rules:
 *   - GRACEFUL NO-OP. When SENTRY_DSN is absent, `init()` logs once and every
 *     other export becomes a cheap passthrough. The daemon must boot + run
 *     identically whether or not Sentry is configured. Observability is
 *     ADDITIVE — it can never be the thing that takes Plyne down.
 *   - Init must run as early as possible (top of src/index.ts) so boot-time
 *     failures are captured. We register process-level handlers ourselves so
 *     even a synchronous throw before any async work reaches Sentry.
 *   - `flushAndExit()` exists because a daemon that calls process.exit(1) on a
 *     FATAL would otherwise drop the in-flight Sentry event. We flush (bounded)
 *     THEN exit.
 *
 * Pattern source: gmr-inc/brynx + gmr-inc/marketear sentry.server.config.ts,
 * ADAPTED from @sentry/nextjs to @sentry/node for a long-lived daemon.
 */
import * as Sentry from "@sentry/node";

let initialized = false;

/**
 * Initialize Sentry. Idempotent + safe to call when SENTRY_DSN is unset
 * (becomes a no-op). Returns whether Sentry is actually active so callers can
 * log the right boot line.
 */
export function initSentry(): boolean {
  if (initialized) return Sentry.isInitialized();
  initialized = true;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // eslint-disable-next-line no-console
    console.log("[sentry] SENTRY_DSN unset — error reporting disabled (no-op).");
    return false;
  }

  const tracesSampleRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1");

  Sentry.init({
    dsn,
    environment: process.env.PLYNE_OBSERVABILITY_ENV ?? "production",
    // The daemon is long-lived; a low trace rate keeps the polling loop from
    // flooding Sentry with identical transactions while still giving signal.
    tracesSampleRate: Number.isFinite(tracesSampleRate) ? tracesSampleRate : 0.1,
    // Tag every event so the daemon is distinguishable from the (separate)
    // ingestion-monitored products that also report into org gmr-inc.
    initialScope: {
      tags: { service: "plyne-v3", component: "daemon" }
    }
  });

  // eslint-disable-next-line no-console
  console.log("[sentry] initialized — error reporting active (env=" +
    (process.env.PLYNE_OBSERVABILITY_ENV ?? "production") + ").");
  return true;
}

/** True when Sentry has a live DSN and is sending events. */
export function sentryEnabled(): boolean {
  return Sentry.isInitialized();
}

/**
 * Capture an exception with optional structured context. No-op (returns
 * undefined) when Sentry is inactive. Never throws.
 */
export function captureException(
  err: unknown,
  context?: Record<string, unknown>
): string | undefined {
  try {
    if (!Sentry.isInitialized()) return undefined;
    return Sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    return undefined;
  }
}

/**
 * Capture a message (e.g. the circuit-breaker trip, a FATAL boot reason that
 * isn't an Error object). No-op when inactive. Never throws.
 */
export function captureMessage(
  message: string,
  level: Sentry.SeverityLevel = "error",
  context?: Record<string, unknown>
): string | undefined {
  try {
    if (!Sentry.isInitialized()) return undefined;
    return Sentry.captureMessage(message, {
      level,
      ...(context ? { extra: context } : {})
    });
  } catch {
    return undefined;
  }
}

/**
 * Register process-level handlers so an uncaught exception / unhandled
 * rejection is reported to Sentry before the process dies. We deliberately do
 * NOT swallow the error — after capturing, an uncaught exception is fatal by
 * design (a daemon in an unknown state should die and let pm2 restart it),
 * but NOW the death is visible in Sentry instead of silent.
 *
 * Safe no-op when Sentry is inactive (handlers still log to stderr).
 */
export function installGlobalHandlers(): void {
  process.on("uncaughtException", (err) => {
    // eslint-disable-next-line no-console
    console.error("[plyne-v3] uncaughtException:", err);
    captureException(err, { handler: "uncaughtException" });
    void flushAndExit(1);
  });

  process.on("unhandledRejection", (reason) => {
    // eslint-disable-next-line no-console
    console.error("[plyne-v3] unhandledRejection:", reason);
    captureException(reason, { handler: "unhandledRejection" });
    // An unhandled rejection leaves the daemon in an undefined state; treat it
    // like an uncaught exception and let pm2 restart — but now it's reported.
    void flushAndExit(1);
  });
}

/**
 * Flush pending Sentry events (bounded wait) THEN exit. Used by the FATAL boot
 * path + global handlers so we never lose the very event that explains why the
 * daemon died (the whole point of this work). Always exits even if flush fails.
 */
export async function flushAndExit(code: number): Promise<never> {
  try {
    if (Sentry.isInitialized()) {
      await Sentry.flush(2000);
    }
  } catch {
    /* flushing observability must never block the exit */
  }
  process.exit(code);
}

/** Bounded flush without exiting — for graceful shutdown. */
export async function flush(timeoutMs = 2000): Promise<void> {
  try {
    if (Sentry.isInitialized()) await Sentry.flush(timeoutMs);
  } catch {
    /* ignore */
  }
}

export { Sentry };
