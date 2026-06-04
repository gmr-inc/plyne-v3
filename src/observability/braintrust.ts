/**
 * Self-observability — Braintrust logging of the daemon's Claude/agent calls.
 *
 * BASELINE "Agent Health" instrumentation. Plyne v3 drives Claude through the
 * `claude` CLI subprocess (src/executor/claude-cli-executor.ts), NOT the
 * Anthropic SDK — so the canonical `wrapAnthropic` pattern from brynx/marketear
 * does NOT apply here. Instead we log each executor invocation manually as a
 * Braintrust span: input (the task + prompt), output (stdout / PR result),
 * latency, exit code, and a coarse cost proxy. That gives us the raw traces an
 * eval dataset can later be built from — without committing to a scorer suite
 * now.
 *
 * GRACEFUL NO-OP: when BRAINTRUST_API_KEY is absent, initLogger is never
 * called and every logging helper short-circuits. The daemon runs identically.
 * Braintrust logging is wrapped so a logging failure never disrupts task
 * execution.
 *
 * Project: `plyne-v3` (org-level, created out of band). initLogger also
 * lazily creates it on first event.
 */
import { initLogger, type Logger, type Span } from "braintrust";

let _logger: Logger<false> | undefined;
let initAttempted = false;

/** True when Braintrust logging is active. */
export function braintrustEnabled(): boolean {
  return Boolean(process.env.BRAINTRUST_API_KEY);
}

/**
 * Initialize the Braintrust logger once. Safe no-op when the key is unset.
 * Returns whether Braintrust is active so the boot path can log the right line.
 */
export function initBraintrust(): boolean {
  if (initAttempted) return Boolean(_logger);
  initAttempted = true;
  if (!process.env.BRAINTRUST_API_KEY) {
    // eslint-disable-next-line no-console
    console.log("[braintrust] BRAINTRUST_API_KEY unset — agent logging disabled (no-op).");
    return false;
  }
  try {
    _logger = initLogger({
      projectName: "plyne-v3",
      apiKey: process.env.BRAINTRUST_API_KEY
    });
    // eslint-disable-next-line no-console
    console.log("[braintrust] initialized — agent invocation logging active (project=plyne-v3).");
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log("[braintrust] init failed — agent logging disabled:", (err as Error)?.message ?? err);
    _logger = undefined;
    return false;
  }
}

/**
 * Structured input describing one Claude executor invocation.
 *
 * Optional fields explicitly allow `undefined` so callers under
 * `exactOptionalPropertyTypes` can pass `field: maybeUndefined` directly.
 */
export interface ExecutorLogInput {
  taskId: string;
  externalId?: string | undefined;
  product?: string | undefined;
  repo?: string | undefined;
  effort?: string | undefined;
  model?: string | undefined;
  prompt?: string | undefined;
}

/** Structured output/metrics for the same invocation. */
export interface ExecutorLogOutput {
  exitCode: number;
  durationMs: number;
  stackSummary?: string | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
  branch?: string | null | undefined;
  prUrl?: string | null | undefined;
  /** Optional terminal disposition the runner determined post-execution. */
  outcome?: string | undefined;
}

// Truncation guard — full stdout/stderr can be large; cap what we ship.
const MAX_FIELD = 8000;
function clip(s: string | undefined | null): string | undefined {
  if (s === undefined || s === null) return undefined;
  return s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) + `…[+${s.length - MAX_FIELD} chars]` : s;
}

/**
 * Log a completed Claude executor invocation to Braintrust as a single span.
 * Never throws. No-op when Braintrust is inactive.
 *
 * Cost note: the CLI runs on the Claude Max OAuth session, which does not bill
 * per-token, so true $ cost is not observable here. We log latency + a token
 * proxy (stdout length) under `metrics`; a real cost dimension can be layered
 * later if/when the executor surfaces usage.
 */
export function logExecutorRun(input: ExecutorLogInput, output: ExecutorLogOutput): void {
  if (!_logger) return;
  try {
    const span: Span = _logger.startSpan({
      name: "claude-executor",
      event: {
        input: {
          taskId: input.taskId,
          externalId: input.externalId,
          product: input.product,
          repo: input.repo,
          effort: input.effort,
          model: input.model,
          prompt: clip(input.prompt)
        },
        output: {
          exitCode: output.exitCode,
          stdout: clip(output.stdout),
          branch: output.branch ?? null,
          prUrl: output.prUrl ?? null,
          outcome: output.outcome
        },
        metadata: {
          service: "plyne-v3",
          stackSummary: output.stackSummary,
          stderr: clip(output.stderr),
          env: process.env.PLYNE_OBSERVABILITY_ENV ?? "production"
        },
        metrics: {
          // Braintrust convention: duration in SECONDS.
          duration: output.durationMs / 1000,
          // Proxy for output volume until real token usage is surfaced.
          output_chars: output.stdout?.length ?? 0
        },
        scores: {
          // Baseline D1-style signal: did Claude exit cleanly? Real scorers
          // (AC pass, PR landed, etc.) are layered onto these traces later.
          exited_clean: output.exitCode === 0 ? 1 : 0
        }
      }
    });
    span.end();
  } catch {
    /* observability must never disrupt task execution */
  }
}

/** Flush pending Braintrust events (best-effort) on shutdown. */
export async function flushBraintrust(): Promise<void> {
  try {
    if (_logger) await _logger.flush();
  } catch {
    /* ignore */
  }
}
