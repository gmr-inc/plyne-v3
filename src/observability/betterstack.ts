/**
 * Self-observability — BetterStack log + trace shipping for the Plyne v3 daemon.
 *
 * Two pipelines, both GRACEFUL NO-OPs when their env is absent:
 *
 *  1. STRUCTURED LOGS (primary). The daemon already logs through pino
 *     (src/config/logger.ts). This module exposes a pino multistream
 *     destination that ships every structured log line to the BetterStack
 *     source over its Logtail/OTLP HTTP ingest. The logger wires it in when
 *     BETTERSTACK_SOURCE_TOKEN + BETTERSTACK_INGESTING_HOST are both set.
 *     Logs are batched + flushed on an interval and on shutdown — a polling
 *     daemon must never block its hot loop on a network write.
 *
 *  2. TRACES (optional parity with brynx/marketear). An OTel Node SDK exports
 *     spans to the same BetterStack source's OTLP endpoint. Started lazily so
 *     the heavy @opentelemetry deps are only loaded when configured.
 *
 * Pattern source: gmr-inc/brynx + gmr-inc/marketear instrumentation.betterstack.ts,
 * ADAPTED from a Next.js instrumentation hook to a Node.js daemon (no
 * NEXT_RUNTIME gating; explicit start/stop tied to the daemon lifecycle).
 *
 * @see https://betterstack.com/docs/logs/http-rest-api/
 * @see https://betterstack.com/docs/logs/open-telemetry/
 */
import { Writable } from "node:stream";

let _host: string | undefined;
let _token: string | undefined;

/** True when both BetterStack source credentials are present. */
export function betterstackEnabled(): boolean {
  return Boolean(process.env.BETTERSTACK_SOURCE_TOKEN && process.env.BETTERSTACK_INGESTING_HOST);
}

// ─── 1. Structured log shipping (pino destination) ─────────────────────────

interface PendingLog {
  // pino hands us a serialized JSON line; we re-parse so BetterStack indexes
  // the structured fields (level, msg, service, taskId, ...) natively.
  [k: string]: unknown;
}

const BATCH_INTERVAL_MS = 2000;
const MAX_BATCH = 100;

let buffer: PendingLog[] = [];
let flushTimer: NodeJS.Timeout | undefined;
let shippingStarted = false;

function ingestUrl(): string {
  const host = _host as string;
  // BetterStack accepts batched JSON arrays at the source root over HTTPS.
  return host.startsWith("http") ? host : `https://${host}`;
}

async function ship(batch: PendingLog[]): Promise<void> {
  if (batch.length === 0) return;
  try {
    await fetch(ingestUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${_token}`
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    // Log shipping is best-effort. A BetterStack outage / network blip must
    // never crash the daemon or stall the loop — we drop the batch and move on.
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    const batch = buffer;
    buffer = [];
    void ship(batch);
  }, BATCH_INTERVAL_MS);
  flushTimer.unref?.();
}

/**
 * A pino-compatible Writable that batches structured log lines and ships them
 * to BetterStack. Returns undefined (so the logger skips the multistream entry)
 * when BetterStack is not configured.
 */
export function createBetterstackPinoStream(): Writable | undefined {
  if (!betterstackEnabled()) return undefined;
  _host = process.env.BETTERSTACK_INGESTING_HOST;
  _token = process.env.BETTERSTACK_SOURCE_TOKEN;
  shippingStarted = true;

  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      try {
        const line = chunk.toString("utf8").trim();
        if (line) {
          // pino emits one JSON object per line. Parse so BetterStack gets
          // structured fields; fall back to a raw message on parse failure.
          let obj: PendingLog;
          try {
            obj = JSON.parse(line) as PendingLog;
          } catch {
            obj = { message: line };
          }
          buffer.push(obj);
          if (buffer.length >= MAX_BATCH) {
            const batch = buffer;
            buffer = [];
            void ship(batch);
          } else {
            scheduleFlush();
          }
        }
      } catch {
        /* never let a logging write throw into pino */
      }
      cb();
    }
  });
}

/** Flush any buffered logs immediately (used on graceful shutdown). */
export async function flushBetterstackLogs(): Promise<void> {
  if (!shippingStarted) return;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  const batch = buffer;
  buffer = [];
  await ship(batch);
}

// ─── 2. OTel trace export (optional parity with brynx/marketear) ───────────

let otelStarted = false;
// Typed loosely: the OTel SDK is dynamically imported so the dep stays optional.
let _sdk: { shutdown: () => Promise<void> } | undefined;

/**
 * Start the OTel Node SDK exporting traces to BetterStack. Best-effort + lazy:
 * if the optional @opentelemetry deps aren't installed, or credentials are
 * missing, it no-ops. Never throws into the boot path.
 */
export async function startBetterstackTraces(): Promise<boolean> {
  if (otelStarted || !betterstackEnabled()) return false;
  const host = process.env.BETTERSTACK_INGESTING_HOST as string;
  const token = process.env.BETTERSTACK_SOURCE_TOKEN as string;
  try {
    // INDIRECTED dynamic imports (variable specifier) so TypeScript does NOT
    // try to resolve these OPTIONAL @opentelemetry modules at compile time. The
    // VPS may run `npm install --omit=optional`; in that case the modules are
    // simply absent and the catch below no-ops (logs still ship via fetch).
    const imp = (m: string): Promise<Record<string, unknown>> =>
      import(/* @vite-ignore */ m) as Promise<Record<string, unknown>>;
    const { NodeSDK } = (await imp("@opentelemetry/sdk-node")) as {
      NodeSDK: new (cfg: unknown) => { start: () => void; shutdown: () => Promise<void> };
    };
    const { OTLPTraceExporter } = (await imp("@opentelemetry/exporter-trace-otlp-http")) as {
      OTLPTraceExporter: new (cfg: unknown) => unknown;
    };
    const { resourceFromAttributes } = (await imp("@opentelemetry/resources")) as {
      resourceFromAttributes: (attrs: Record<string, unknown>) => unknown;
    };
    const { ATTR_SERVICE_NAME } = (await imp("@opentelemetry/semantic-conventions")) as {
      ATTR_SERVICE_NAME: string;
    };

    const exporter = new OTLPTraceExporter({
      url: `https://${host}/v1/traces`,
      headers: { Authorization: `Bearer ${token}` }
    });

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: "plyne-v3",
        "service.namespace": "gmr",
        "deployment.environment": process.env.PLYNE_OBSERVABILITY_ENV ?? "production"
      }),
      traceExporter: exporter
    });
    sdk.start();
    _sdk = sdk;
    otelStarted = true;
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(
      "[betterstack] OTel trace SDK not started (deps absent or init failed) — logs still ship:",
      (err as Error)?.message ?? err
    );
    return false;
  }
}

/** Shut the OTel SDK down (best-effort) on daemon shutdown. */
export async function stopBetterstackTraces(): Promise<void> {
  try {
    if (_sdk) await _sdk.shutdown();
  } catch {
    /* ignore */
  }
}
