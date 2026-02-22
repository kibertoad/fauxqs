import { describe, it, expect, vi, afterEach } from "vitest";
import { SqsQueue } from "../../src/sqs/sqsStore.js";

describe("FIFO dedup window expiry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows same dedup ID after 5-minute TTL expires", () => {
    vi.useFakeTimers();

    const queue = new SqsQueue(
      "test.fifo",
      "http://sqs.us-east-1.localhost:3000/000000000000/test.fifo",
      "arn:aws:sqs:us-east-1:000000000000:test.fifo",
      { FifoQueue: "true" },
    );

    queue.recordDeduplication("dedup-1", "msg-1", "00000000000000000001");
    const check1 = queue.checkDeduplication("dedup-1");
    expect(check1.isDuplicate).toBe(true);
    expect(check1.originalMessageId).toBe("msg-1");

    // Advance past the 5-minute dedup window
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const check2 = queue.checkDeduplication("dedup-1");
    expect(check2.isDuplicate).toBe(false);
  });
});
