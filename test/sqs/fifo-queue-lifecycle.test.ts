import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  SendMessageBatchCommand,
  PurgeQueueCommand,
  ChangeMessageVisibilityCommand,
  ChangeMessageVisibilityBatchCommand,
  TagQueueCommand,
  UntagQueueCommand,
  ListQueueTagsCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS non-existent queue errors", () => {
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

  it("GetQueueUrl throws QueueDoesNotExist for missing queue", async () => {
    try {
      await sqs.send(new GetQueueUrlCommand({ QueueName: "nonexistent-queue" }));
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("QueueDoesNotExist");
      expect(err.Code).toBe("AWS.SimpleQueueService.NonExistentQueue");
    }
  });

  it("DeleteQueue throws QueueDoesNotExist for missing queue", async () => {
    try {
      await sqs.send(
        new DeleteQueueCommand({
          QueueUrl: "http://sqs.us-east-1.localhost:1/000000000000/nonexistent",
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("QueueDoesNotExist");
      expect(err.Code).toBe("AWS.SimpleQueueService.NonExistentQueue");
    }
  });

  it("SendMessage throws QueueDoesNotExist for missing queue", async () => {
    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: "http://sqs.us-east-1.localhost:1/000000000000/nonexistent",
          MessageBody: "test",
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("QueueDoesNotExist");
      expect(err.Code).toBe("AWS.SimpleQueueService.NonExistentQueue");
    }
  });

  it("ReceiveMessage throws QueueDoesNotExist for missing queue", async () => {
    try {
      await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: "http://sqs.us-east-1.localhost:1/000000000000/nonexistent",
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("QueueDoesNotExist");
      expect(err.Code).toBe("AWS.SimpleQueueService.NonExistentQueue");
    }
  });

  it("GetQueueAttributes throws QueueDoesNotExist for missing queue", async () => {
    try {
      await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: "http://sqs.us-east-1.localhost:1/000000000000/nonexistent",
          AttributeNames: ["All"],
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("QueueDoesNotExist");
      expect(err.Code).toBe("AWS.SimpleQueueService.NonExistentQueue");
    }
  });

  it("PurgeQueue throws QueueDoesNotExist for missing queue", async () => {
    try {
      await sqs.send(
        new PurgeQueueCommand({
          QueueUrl: "http://sqs.us-east-1.localhost:1/000000000000/nonexistent",
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("QueueDoesNotExist");
      expect(err.Code).toBe("AWS.SimpleQueueService.NonExistentQueue");
    }
  });

  it("SendMessageBatch throws QueueDoesNotExist for missing queue", async () => {
    try {
      await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: "http://sqs.us-east-1.localhost:1/000000000000/nonexistent",
          Entries: [{ Id: "1", MessageBody: "test" }],
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("QueueDoesNotExist");
      expect(err.Code).toBe("AWS.SimpleQueueService.NonExistentQueue");
    }
  });

  it("DeleteMessage throws QueueDoesNotExist for missing queue", async () => {
    try {
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: "http://sqs.us-east-1.localhost:1/000000000000/nonexistent",
          ReceiptHandle: "fake-handle",
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("QueueDoesNotExist");
      expect(err.Code).toBe("AWS.SimpleQueueService.NonExistentQueue");
    }
  });

  it("DeleteMessageBatch throws QueueDoesNotExist for missing queue", async () => {
    try {
      await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: "http://sqs.us-east-1.localhost:1/000000000000/nonexistent",
          Entries: [{ Id: "1", ReceiptHandle: "fake-handle" }],
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("QueueDoesNotExist");
      expect(err.Code).toBe("AWS.SimpleQueueService.NonExistentQueue");
    }
  });

  it("SetQueueAttributes throws QueueDoesNotExist for missing queue", async () => {
    try {
      await sqs.send(
        new SetQueueAttributesCommand({
          QueueUrl: "http://sqs.us-east-1.localhost:1/000000000000/nonexistent",
          Attributes: { VisibilityTimeout: "30" },
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("QueueDoesNotExist");
      expect(err.Code).toBe("AWS.SimpleQueueService.NonExistentQueue");
    }
  });

  it("ChangeMessageVisibility throws QueueDoesNotExist for missing queue", async () => {
    try {
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: "http://sqs.us-east-1.localhost:1/000000000000/nonexistent",
          ReceiptHandle: "fake-handle",
          VisibilityTimeout: 30,
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("QueueDoesNotExist");
      expect(err.Code).toBe("AWS.SimpleQueueService.NonExistentQueue");
    }
  });

  it("ChangeMessageVisibilityBatch throws QueueDoesNotExist for missing queue", async () => {
    try {
      await sqs.send(
        new ChangeMessageVisibilityBatchCommand({
          QueueUrl: "http://sqs.us-east-1.localhost:1/000000000000/nonexistent",
          Entries: [{ Id: "1", ReceiptHandle: "fake-handle", VisibilityTimeout: 30 }],
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("QueueDoesNotExist");
      expect(err.Code).toBe("AWS.SimpleQueueService.NonExistentQueue");
    }
  });

  it("TagQueue throws QueueDoesNotExist for missing queue", async () => {
    try {
      await sqs.send(
        new TagQueueCommand({
          QueueUrl: "http://sqs.us-east-1.localhost:1/000000000000/nonexistent",
          Tags: { key: "value" },
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("QueueDoesNotExist");
      expect(err.Code).toBe("AWS.SimpleQueueService.NonExistentQueue");
    }
  });

  it("UntagQueue throws QueueDoesNotExist for missing queue", async () => {
    try {
      await sqs.send(
        new UntagQueueCommand({
          QueueUrl: "http://sqs.us-east-1.localhost:1/000000000000/nonexistent",
          TagKeys: ["key"],
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("QueueDoesNotExist");
      expect(err.Code).toBe("AWS.SimpleQueueService.NonExistentQueue");
    }
  });

  it("ListQueueTags throws QueueDoesNotExist for missing queue", async () => {
    try {
      await sqs.send(
        new ListQueueTagsCommand({
          QueueUrl: "http://sqs.us-east-1.localhost:1/000000000000/nonexistent",
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.name).toBe("QueueDoesNotExist");
      expect(err.Code).toBe("AWS.SimpleQueueService.NonExistentQueue");
    }
  });
});

describe("FIFO queue delete-and-recreate lifecycle", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;
  const queueName = "lifecycle-test.fifo";

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  async function deleteAndVerifyGone() {
    const urlResp = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    await sqs.send(new DeleteQueueCommand({ QueueUrl: urlResp.QueueUrl! }));

    // Verify it's gone from ListQueues
    const list = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: queueName }));
    expect(list.QueueUrls ?? []).toHaveLength(0);

    // Verify GetQueueUrl throws
    await expect(
      sqs.send(new GetQueueUrlCommand({ QueueName: queueName })),
    ).rejects.toThrow();
  }

  async function createQueue() {
    const result = await sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "true",
          VisibilityTimeout: "30",
        },
      }),
    );
    return result.QueueUrl!;
  }

  it("send and receive works on a fresh FIFO queue", async () => {
    const queueUrl = await createQueue();

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ userId: "user-1", type: "Added", run: 1 }),
        MessageGroupId: "test-group",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl }),
    );
    expect(received.Messages).toHaveLength(1);
    expect(JSON.parse(received.Messages![0].Body!).userId).toBe("user-1");

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: received.Messages![0].ReceiptHandle!,
      }),
    );
  });

  it("after delete-and-recreate, FIFO group locking is fresh", async () => {
    // Delete the queue from previous test (which had a message consumed from "test-group")
    await deleteAndVerifyGone();

    // Recreate with same name
    const queueUrl = await createQueue();

    // "test-group" should NOT be locked on the new queue
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ userId: "user-2", type: "Deleted", run: 2 }),
        MessageGroupId: "test-group",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl }),
    );
    expect(received.Messages).toHaveLength(1);
    expect(JSON.parse(received.Messages![0].Body!).userId).toBe("user-2");

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: received.Messages![0].ReceiptHandle!,
      }),
    );
  });

  it("after delete-and-recreate, deduplication cache is fresh", async () => {
    await deleteAndVerifyGone();
    const queueUrl = await createQueue();

    // Send same body as first test — should NOT be deduplicated (fresh cache)
    const sendResult = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ userId: "user-1", type: "Added", run: 1 }),
        MessageGroupId: "test-group",
      }),
    );
    expect(sendResult.MessageId).toBeDefined();

    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl }),
    );
    expect(received.Messages).toHaveLength(1);

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: received.Messages![0].ReceiptHandle!,
      }),
    );
  });

  it("after delete-and-recreate, sequence numbers restart", async () => {
    await deleteAndVerifyGone();
    const queueUrl = await createQueue();

    const result = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "fresh-sequence",
        MessageGroupId: "group1",
      }),
    );

    // Sequence numbers should start from 1 on a fresh queue
    expect(result.SequenceNumber).toBe("00000000000000000001");
  });

  it("delete-and-recreate with inflight messages: new queue is clean", async () => {
    // Get the queue from previous test
    const urlResp = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
    const oldQueueUrl = urlResp.QueueUrl!;

    // Send a message and receive it (leaving it inflight, not deleted)
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: oldQueueUrl,
        MessageBody: "inflight-msg",
        MessageGroupId: "test-group",
      }),
    );
    const inflight = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: oldQueueUrl }),
    );
    expect(inflight.Messages).toHaveLength(1);
    // Do NOT delete the message — leave it inflight

    // Now delete and recreate the queue
    await sqs.send(new DeleteQueueCommand({ QueueUrl: oldQueueUrl }));
    const queueUrl = await createQueue();

    // New queue should have no messages at all
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
        ],
      }),
    );
    expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe("0");
    expect(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe("0");

    // Should be able to send and receive on "test-group" immediately (not locked)
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "after-inflight",
        MessageGroupId: "test-group",
      }),
    );
    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl }),
    );
    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("after-inflight");
  });
});

describe("FIFO queue delete-and-recreate with concurrent long-poll", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;
  const queueName = "longpoll-lifecycle.fifo";

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("long-poll resolves when queue is deleted, new queue works independently", async () => {
    // Create queue
    const create1 = await sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "true",
        },
      }),
    );
    const queueUrl = create1.QueueUrl!;

    // Start a long-poll (WaitTimeSeconds=5) — this will be waiting for messages
    const longPollPromise = sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        WaitTimeSeconds: 5,
      }),
    );

    // Give the long-poll time to start
    await new Promise((r) => setTimeout(r, 100));

    // Delete the queue while long-poll is active
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));

    // Long-poll should resolve (not hang)
    const longPollResult = await longPollPromise;
    expect(longPollResult.Messages).toBeUndefined();

    // Recreate queue with same name
    const create2 = await sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "true",
        },
      }),
    );
    const newQueueUrl = create2.QueueUrl!;

    // Send and receive on the new queue — should work fine
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: newQueueUrl,
        MessageBody: "after-longpoll-delete",
        MessageGroupId: "test-group",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: newQueueUrl }),
    );
    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("after-longpoll-delete");
  });
});
