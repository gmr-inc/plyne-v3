/**
 * SSE endpoint at `GET /activity/stream` — streams runner lifecycle events
 * to plyne-app's Dashboard via a Server-Sent Events connection.
 *
 * Auth: `Authorization: Bearer ${PLYNE_DAEMON_API_TOKEN}`. The token is
 * shared with plyne-app's proxy route — the proxy is what enforces Supabase
 * session auth in front of this endpoint, so internet-facing requests must
 * always come pre-authenticated via that bearer.
 *
 * Wire format (text/event-stream):
 *   - `event: activity` + `data: <json ActivityEvent>` for each lifecycle event
 *   - `event: ping` + `data: {}` every 30s as keep-alive (NLB / Cloudflare
 *     idle-timeout protection — 60s on Hetzner edge, 100s on Cloudflare)
 *   - on connect, the last N buffered events are replayed first so a
 *     dashboard tab refreshed mid-task sees recent activity without waiting
 *
 * Lifecycle: the endpoint cleans up its subscription + ping interval on the
 * `close` event from the underlying socket (whether the client navigated away
 * or the proxy upstream died).
 */
import type { Request, Response } from "express";
import { logger } from "../config/logger.js";
import { getEventBus, type ActivityEvent } from "../lib/event-bus.js";

const PING_INTERVAL_MS = 30_000;

/**
 * Read the configured shared-secret bearer for daemon → app SSE traffic.
 * Returns null when missing (caller MUST reject — we will not silently
 * allow unauthenticated SSE).
 */
function getDaemonApiToken(): string | null {
  const tok = process.env.PLYNE_DAEMON_API_TOKEN;
  return tok && tok.length > 0 ? tok : null;
}

/**
 * Constant-time string compare — avoids leaking token contents via timing
 * differences. Length mismatch short-circuits (leaks only length, not bytes).
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify the Authorization header carries the configured bearer. Returns
 * true on success; on failure writes the appropriate error response and
 * returns false (caller must not write further).
 */
export function authorizeBearer(req: Request, res: Response): boolean {
  const expected = getDaemonApiToken();
  if (!expected) {
    res.status(503).json({ error: "PLYNE_DAEMON_API_TOKEN not configured" });
    return false;
  }
  const header = req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1] || !safeEqual(match[1], expected)) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

/**
 * Serialize one ActivityEvent into a single SSE frame. Exported for tests
 * so we can assert the exact bytes that go on the wire.
 */
export function serializeActivityFrame(event: ActivityEvent): string {
  // SSE: `event: <name>\ndata: <json>\n\n`. Newlines inside the JSON would
  // break framing, so we always emit single-line JSON.
  return `event: activity\ndata: ${JSON.stringify(event)}\n\n`;
}

export function serializePingFrame(): string {
  return `event: ping\ndata: {}\n\n`;
}

/**
 * Express handler — does NOT return a Promise (response stays open until
 * client disconnects). Mount with `app.get("/activity/stream", handleSseStream)`.
 */
export function handleSseStream(req: Request, res: Response): void {
  if (!authorizeBearer(req, res)) return;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Disable buffering on proxies (Nginx) that read this header.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const bus = getEventBus();

  // Replay recent events so a freshly-connected dashboard sees what just
  // happened (within the bus's ring-buffer window).
  for (const past of bus.snapshot()) {
    res.write(serializeActivityFrame(past));
  }
  // Initial ping so the client's EventSource `onopen` fires immediately and
  // the UI can switch from "connecting" → "connected" without waiting up
  // to PING_INTERVAL_MS for the first frame on an idle system.
  res.write(serializePingFrame());

  const unsubscribe = bus.subscribe((event) => {
    try {
      res.write(serializeActivityFrame(event));
    } catch (err) {
      logger.warn({ err }, "activity-stream: write failed (client likely disconnected)");
    }
  });

  const pingTimer = setInterval(() => {
    try {
      res.write(serializePingFrame());
    } catch {
      /* harmless — close handler will tear everything down */
    }
  }, PING_INTERVAL_MS);

  const cleanup = () => {
    clearInterval(pingTimer);
    unsubscribe();
    logger.debug({ remoteAddr: req.ip }, "activity-stream: client disconnected");
  };
  req.on("close", cleanup);
  req.on("aborted", cleanup);

  logger.info({ remoteAddr: req.ip }, "activity-stream: client connected");
}
