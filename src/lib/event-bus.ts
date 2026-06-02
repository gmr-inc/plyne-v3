/**
 * Process-singleton EventBus for runner lifecycle events.
 *
 * Why a singleton: the runner (orchestrator) emits state-transition events
 * and the SSE endpoint (api/activity-stream) subscribes to them. Both live
 * in the same process; we don't need cross-process pub/sub. A plain
 * EventEmitter beats Redis here.
 *
 * Why a small ring buffer: SSE clients arrive late. Without a buffer, a
 * dashboard tab refreshed after `task.picked` would see nothing until the
 * next event. We keep the last N events so newly-connected clients can
 * replay (this is the same pattern statuspage SSE feeds use).
 *
 * No external coupling: the bus has no knowledge of HTTP, Notion, or git.
 * Producers call `bus.emitActivity({...})`, consumers call `bus.subscribe(fn)`.
 */
import { EventEmitter } from "node:events";

export type ActivityEventType =
  | "task.picked"
  | "task.executor.started"
  | "task.pr.opened"
  | "task.done"
  | "task.failed"
  | "task.escalated";

export interface ActivityEvent {
  /** ISO-8601 timestamp at emit time. */
  ts: string;
  event_type: ActivityEventType;
  /** Notion page id (UUID). */
  task_id: string;
  /** Human-readable task title (truncated to 200 chars). */
  task_name: string;
  /** Repo this task is scoped to ("cto-v2", "brynx", "(unknown)"). */
  task_repo: string;
  /** Event-specific payload (PR url, error msg, branch, etc.). */
  details: Record<string, unknown>;
}

const ACTIVITY_CHANNEL = "activity";
const RING_BUFFER_MAX = 50;

class PlyneEventBus {
  private readonly emitter = new EventEmitter();
  private readonly buffer: ActivityEvent[] = [];

  constructor() {
    // SSE responses can pile up; the default 10-listener cap throws noisy
    // warnings under modest dashboard fan-out. 100 is comfortably above any
    // realistic operator-console open-tab count.
    this.emitter.setMaxListeners(100);
  }

  emitActivity(event: Omit<ActivityEvent, "ts"> & { ts?: string }): ActivityEvent {
    const full: ActivityEvent = {
      ts: event.ts ?? new Date().toISOString(),
      event_type: event.event_type,
      task_id: event.task_id,
      task_name: event.task_name,
      task_repo: event.task_repo,
      details: event.details ?? {}
    };
    this.buffer.push(full);
    if (this.buffer.length > RING_BUFFER_MAX) this.buffer.shift();
    this.emitter.emit(ACTIVITY_CHANNEL, full);
    return full;
  }

  /** Subscribe to live events. Returns an unsubscribe fn. */
  subscribe(listener: (e: ActivityEvent) => void): () => void {
    this.emitter.on(ACTIVITY_CHANNEL, listener);
    return () => this.emitter.off(ACTIVITY_CHANNEL, listener);
  }

  /** Snapshot of the most recent events (oldest → newest). For replay on
   * subscriber connect. */
  snapshot(): ActivityEvent[] {
    return [...this.buffer];
  }

  /** Test-only — wipe state between unit tests. */
  _resetForTests(): void {
    this.buffer.length = 0;
    this.emitter.removeAllListeners(ACTIVITY_CHANNEL);
    this.emitter.setMaxListeners(100);
  }
}

let cached: PlyneEventBus | undefined;

export function getEventBus(): PlyneEventBus {
  if (!cached) cached = new PlyneEventBus();
  return cached;
}

export type { PlyneEventBus };
