import { describe, expect, it, vi } from "vitest";
import {
  conditionalRemaining, flushQueue, queueEvent, reminderDue, validateEventTime,
} from "../research-core.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

describe("conditional survival estimate", () => {
  it("matches the baseline median at arrival", () => {
    expect(conditionalRemaining(210, 480, 0).p50).toBeCloseTo(210, -1);
  });

  it("conditions on still waiting instead of subtracting elapsed time", () => {
    const estimate = conditionalRemaining(210, 480, 180);
    expect(estimate.suppressed).toBeNull();
    expect(estimate.p50).not.toBe(30);
    expect(estimate.p25).toBeLessThanOrEqual(estimate.p50);
    expect(estimate.p50).toBeLessThanOrEqual(estimate.p90);
  });

  it("suppresses invalid and unsupported tails", () => {
    expect(conditionalRemaining(null, null, 10).suppressed).toBe("official_baseline_unavailable");
    expect(conditionalRemaining(200, 100, 10).suppressed).toBe("invalid_official_distribution");
    expect(conditionalRemaining(210, 480, 100000).suppressed).toBe("outside_supported_tail");
  });
});

describe("longitudinal event handling", () => {
  it("accepts event times only between arrival and now", () => {
    const now = new Date("2026-07-15T12:00:00Z");
    expect(validateEventTime("2026-07-15T08:00:00Z", "2026-07-15T10:00:00Z", now)).toBe(true);
    expect(validateEventTime("2026-07-15T08:00:00Z", "2026-07-15T07:59:00Z", now)).toBe(false);
  });

  it("prompts only active sessions after fifteen minutes", () => {
    const now = new Date("2026-07-15T12:00:00Z");
    expect(reminderDue({ status: "waiting", enrolled_at: "2026-07-15T11:44:59Z" }, now)).toBe(true);
    expect(reminderDue({ status: "seen_doctor", enrolled_at: "2026-07-15T10:00:00Z" }, now)).toBe(false);
  });

  it("keeps event ids idempotent and retries failures offline", async () => {
    const storage = memoryStorage();
    const event = { event_id: "42", event_type: "still_waiting" };
    queueEvent(storage, event); queueEvent(storage, event);
    const sender = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({});
    expect((await flushQueue(storage, sender)).remaining).toBe(1);
    expect((await flushQueue(storage, sender)).remaining).toBe(0);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it("deduplicates queue observations and preserves their endpoint", async () => {
    const storage = memoryStorage();
    const observation = {
      endpoint: "wait-session-queue", observation_id: "observation-42",
      observation_kind: "higher_priority_called",
    };
    queueEvent(storage, observation); queueEvent(storage, observation);
    const sender = vi.fn().mockResolvedValue({});
    expect((await flushQueue(storage, sender)).sent).toBe(1);
    expect(sender).toHaveBeenCalledWith(observation);
  });
});
