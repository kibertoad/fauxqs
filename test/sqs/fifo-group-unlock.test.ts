import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("FIFO group unlock during long-poll", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  /**
   * Bug: processTimers() called notifyWaiters() whenever hasFifoMessages()
   * was true, even when all message groups were locked. This falsely woke
   * long-poll waiters, which called dequeueFifo(), found the group locked,
   * and returned empty. The waiter was consumed, so when the group later
   * unlocked there was no waiter left to receive the message.
   *
   * Fix: hasAvailableFifoMessages() now checks that the group is not locked.
   */
  it("processTimers does not falsely wake long-poll waiters for locked groups", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `timer-wakeup-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      }),
    );

    // Send msg-1 and receive it — locks the group
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "msg-1",
        MessageGroupId: "grp",
      }),
    );
    const first = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: QueueUrl! }),
    );
    expect(first.Messages).toHaveLength(1);

    // Send msg-2 to the same (now locked) group
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "msg-2",
        MessageGroupId: "grp",
      }),
    );

    // Start a long-poll. The group is locked so dequeue returns empty and
    // we enter waitForMessages(). The processTimers interval (20ms) will
    // fire multiple times while we wait. It must NOT wake this waiter,
    // because the only group with messages is locked.
    const longPoll = sqs.send(
      new ReceiveMessageCommand({ QueueUrl: QueueUrl!, WaitTimeSeconds: 5 }),
    );

    // Let processTimers fire several times (~10 cycles at 20ms)
    await new Promise((r) => setTimeout(r, 250));

    // Now delete msg-1 — this unlocks the group and should notify the waiter
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: QueueUrl!,
        ReceiptHandle: first.Messages![0].ReceiptHandle!,
      }),
    );

    // The long-poll should resolve promptly with msg-2 (not time out at 5s)
    const result = await longPoll;
    expect(result.Messages).toHaveLength(1);
    expect(result.Messages![0].Body).toBe("msg-2");
  });

  /**
   * Bug: deleteMessage() decremented fifoLockedGroups but never called
   * notifyWaiters(). A consumer long-polling for a locked group would
   * never be woken up when the lock was released.
   *
   * Fix: deleteMessage() now calls notifyWaiters() when a group fully
   * unlocks and has queued messages.
   */
  it("deleteMessage wakes long-poll waiters when group unlocks", async () => {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `delete-notify-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      }),
    );

    // Send and receive msg-1 — locks "grp"
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "msg-1",
        MessageGroupId: "grp",
      }),
    );
    const first = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: QueueUrl! }),
    );

    // Send msg-2 to the locked group
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl!,
        MessageBody: "msg-2",
        MessageGroupId: "grp",
      }),
    );

    // Start long-poll — the group is locked so this enters waitForMessages
    const longPoll = sqs.send(
      new ReceiveMessageCommand({ QueueUrl: QueueUrl!, WaitTimeSeconds: 5 }),
    );

    // Give the long-poll time to register as a waiter
    await new Promise((r) => setTimeout(r, 50));

    // Delete msg-1 — the group unlocks. deleteMessage must call
    // notifyWaiters() so that the long-poll wakes up and dequeues msg-2.
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: QueueUrl!,
        ReceiptHandle: first.Messages![0].ReceiptHandle!,
      }),
    );

    // If deleteMessage did NOT notify, this would hang for 5 seconds and
    // return undefined. With the fix it resolves immediately.
    const result = await longPoll;
    expect(result.Messages).toHaveLength(1);
    expect(result.Messages![0].Body).toBe("msg-2");
  });
});
