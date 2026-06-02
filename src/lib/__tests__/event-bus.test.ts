/**
 * EventBus tests — pure in-memory pub/sub. No HTTP, no Notion. Runs via
 * `node --test` matching the rest of v3.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getEventBus, type ActivityEvent } from "../event-bus.js";

const bus = getEventBus();

beforeEach(() => {
  bus._resetForTests();
});

describe("EventBus", () => {
  it("delivers a published event to a live subscriber", () => {
    const received: ActivityEvent[] = [];
    bus.subscribe((e) => received.push(e));
    bus.emitActivity({
      event_type: "task.picked",
      task_id: "task-1",
      task_name: "wire SSE",
      task_repo: "plyne-v3",
      details: {}
    });
    assert.equal(received.length, 1);
    assert.equal(received[0]?.event_type, "task.picked");
    assert.equal(received[0]?.task_id, "task-1");
    assert.match(received[0]?.ts ?? "", /^\d{4}-\d{2}-\d{2}T/);
  });

  it("stops delivering after unsubscribe", () => {
    const received: ActivityEvent[] = [];
    const off = bus.subscribe((e) => received.push(e));
    bus.emitActivity({
      event_type: "task.picked",
      task_id: "t",
      task_name: "n",
      task_repo: "r",
      details: {}
    });
    off();
    bus.emitActivity({
      event_type: "task.done",
      task_id: "t",
      task_name: "n",
      task_repo: "r",
      details: {}
    });
    assert.equal(received.length, 1);
  });

  it("snapshot returns last events for late subscribers", () => {
    for (let i = 0; i < 3; i++) {
      bus.emitActivity({
        event_type: "task.picked",
        task_id: `t-${i}`,
        task_name: "n",
        task_repo: "r",
        details: { i }
      });
    }
    const snap = bus.snapshot();
    assert.equal(snap.length, 3);
    assert.equal(snap[0]?.task_id, "t-0");
    assert.equal(snap[2]?.task_id, "t-2");
  });

  it("ring buffer trims to 50 entries", () => {
    for (let i = 0; i < 75; i++) {
      bus.emitActivity({
        event_type: "task.picked",
        task_id: `t-${i}`,
        task_name: "n",
        task_repo: "r",
        details: {}
      });
    }
    const snap = bus.snapshot();
    assert.equal(snap.length, 50);
    // oldest 25 should have been evicted; first remaining id is t-25
    assert.equal(snap[0]?.task_id, "t-25");
    assert.equal(snap[49]?.task_id, "t-74");
  });

  it("emitActivity returns the persisted event with ts auto-filled", () => {
    const evt = bus.emitActivity({
      event_type: "task.failed",
      task_id: "x",
      task_name: "n",
      task_repo: "r",
      details: { error: "boom" }
    });
    assert.ok(evt.ts);
    assert.deepEqual(evt.details, { error: "boom" });
  });

  it("singleton returns the same bus on repeated calls", () => {
    const a = getEventBus();
    const b = getEventBus();
    assert.equal(a, b);
  });
});
