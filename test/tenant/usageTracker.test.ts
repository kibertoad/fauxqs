import { describe, it, expect, beforeEach } from "vitest";
import { UsageTracker } from "../../src/tenant/usageTracker.js";

describe("UsageTracker", () => {
  let tracker: UsageTracker;

  beforeEach(() => {
    tracker = new UsageTracker();
  });

  it("register and get", () => {
    tracker.register("queue-1", "env1-");
    const entry = tracker.get("queue-1");
    expect(entry).toBeDefined();
    expect(entry!.prefix).toBe("env1-");
    expect(entry!.lastUsedMs).toBeGreaterThan(0);
  });

  it("register with null prefix", () => {
    tracker.register("admin-queue", null);
    expect(tracker.get("admin-queue")!.prefix).toBeNull();
  });

  it("touch updates lastUsedMs for registered resource", async () => {
    tracker.register("queue-1", "env1-");
    const before = tracker.get("queue-1")!.lastUsedMs;
    // Small delay to ensure timestamp changes
    await new Promise((r) => setTimeout(r, 5));
    tracker.touch("queue-1");
    expect(tracker.get("queue-1")!.lastUsedMs).toBeGreaterThan(before);
  });

  it("touch is a no-op for unregistered resource", () => {
    tracker.touch("nonexistent");
    expect(tracker.get("nonexistent")).toBeUndefined();
  });

  it("delete removes entry", () => {
    tracker.register("queue-1", "env1-");
    tracker.delete("queue-1");
    expect(tracker.get("queue-1")).toBeUndefined();
    expect(tracker.size).toBe(0);
  });

  it("size reflects tracked count", () => {
    expect(tracker.size).toBe(0);
    tracker.register("a", "p-");
    tracker.register("b", "p-");
    expect(tracker.size).toBe(2);
  });

  it("clear removes all entries", () => {
    tracker.register("a", "p-");
    tracker.register("b", "p-");
    tracker.clear();
    expect(tracker.size).toBe(0);
  });

  describe("scan", () => {
    beforeEach(() => {
      tracker.register("a", "p1-");
      tracker.register("b", "p1-");
      tracker.register("c", "p2-");
      tracker.register("d", "p2-");
      tracker.register("e", "p3-");
    });

    it("scans from beginning when cursor is undefined", () => {
      const result = tracker.scan(undefined, 3);
      expect(result.visited).toHaveLength(3);
      expect(result.visited.map(([name]) => name)).toEqual(["a", "b", "c"]);
      expect(result.wrapped).toBe(false);
    });

    it("scans from cursor position", () => {
      const result = tracker.scan("b", 2);
      expect(result.visited.map(([name]) => name)).toEqual(["c", "d"]);
      expect(result.wrapped).toBe(false);
    });

    it("wraps around when reaching end", () => {
      const result = tracker.scan("d", 3);
      // After d: e, then wraps to a, b (cursor "d" is included at the end of a full cycle)
      expect(result.visited.map(([name]) => name)).toEqual(["e", "a", "b"]);
      expect(result.wrapped).toBe(true);
    });

    it("includes cursor entry in wrap to ensure full coverage", () => {
      // Cursor = last entry "e". Next scan: wraps to start, visits a,b,c,d,e
      const result = tracker.scan("e", 5);
      expect(result.visited.map(([name]) => name)).toEqual(["a", "b", "c", "d", "e"]);
      expect(result.wrapped).toBe(true);
    });

    it("handles budget larger than entries", () => {
      const result = tracker.scan(undefined, 100);
      expect(result.visited).toHaveLength(5);
      expect(result.wrapped).toBe(true);
    });

    it("handles empty tracker", () => {
      const empty = new UsageTracker();
      const result = empty.scan(undefined, 10);
      expect(result.visited).toHaveLength(0);
      expect(result.wrapped).toBe(true);
    });
  });

  describe("nextAfter", () => {
    it("returns next key after given name", () => {
      tracker.register("a", "p-");
      tracker.register("b", "p-");
      tracker.register("c", "p-");
      expect(tracker.nextAfter("a")).toBe("b");
      expect(tracker.nextAfter("b")).toBe("c");
    });

    it("returns undefined when name is last entry", () => {
      tracker.register("a", "p-");
      tracker.register("b", "p-");
      expect(tracker.nextAfter("b")).toBeUndefined();
    });

    it("returns undefined when name is not found", () => {
      tracker.register("a", "p-");
      expect(tracker.nextAfter("missing")).toBeUndefined();
    });
  });
});
