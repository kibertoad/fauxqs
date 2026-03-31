import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ChangeMessageVisibilityCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS Send/Receive/Delete", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;
  let queueUrl: string;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  beforeEach(async () => {
    const result = await sqs.send(
      new CreateQueueCommand({
        QueueName: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }),
    );
    queueUrl = result.QueueUrl!;
  });

  it("sends and receives a message", async () => {
    const sent = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "hello world",
      }),
    );

    expect(sent.MessageId).toBeDefined();
    expect(sent.MD5OfMessageBody).toBeDefined();

    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl }),
    );

    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("hello world");
    expect(received.Messages![0].MessageId).toBe(sent.MessageId);
    expect(received.Messages![0].MD5OfBody).toBe(sent.MD5OfMessageBody);
    // Real AWS receipt handles are ~350-char base64 opaque tokens, not UUIDs.
    const handle = received.Messages![0].ReceiptHandle!;
    expect(handle.length).toBeGreaterThan(100);
    expect(handle).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("receives empty when no messages", async () => {
    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl }),
    );

    expect(received.Messages).toBeUndefined();
  });

  it("deletes a message", async () => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "delete me",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl }),
    );
    const receiptHandle = received.Messages![0].ReceiptHandle!;

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );

    // Message should not be receivable again
    const afterDelete = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl }),
    );
    expect(afterDelete.Messages).toBeUndefined();
  });

  it("receives up to MaxNumberOfMessages", async () => {
    for (let i = 0; i < 5; i++) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: `message ${i}`,
        }),
      );
    }

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 3,
      }),
    );

    expect(received.Messages).toHaveLength(3);
  });

  it("sends message with attributes", async () => {
    const sent = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "with attrs",
        MessageAttributes: {
          MyString: { DataType: "String", StringValue: "hello" },
          MyNumber: { DataType: "Number", StringValue: "42" },
        },
      }),
    );

    expect(sent.MD5OfMessageAttributes).toBeDefined();

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MessageAttributeNames: ["All"],
      }),
    );

    const msg = received.Messages![0];
    expect(msg.MessageAttributes?.MyString?.StringValue).toBe("hello");
    expect(msg.MessageAttributes?.MyNumber?.StringValue).toBe("42");
    expect(msg.MD5OfMessageAttributes).toBe(sent.MD5OfMessageAttributes);
  });

  it("receives system attributes when requested", async () => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "system attrs",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["All"],
      }),
    );

    const attrs = received.Messages![0].Attributes;
    expect(attrs?.SentTimestamp).toBeDefined();
    expect(attrs?.ApproximateReceiveCount).toBe("1");
    expect(attrs?.ApproximateFirstReceiveTimestamp).toBeDefined();
  });

  it("makes message invisible after receive", async () => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "invisible test",
      }),
    );

    // First receive — should get the message
    const first = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl }),
    );
    expect(first.Messages).toHaveLength(1);

    // Second receive — message should be invisible
    const second = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl }),
    );
    expect(second.Messages).toBeUndefined();
  });

  it("tracks approximate message counts", async () => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "count test 1",
      }),
    );
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "count test 2",
      }),
    );

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
        ],
      }),
    );

    expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe("2");
    expect(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe("0");

    // Receive one message (moves to inflight)
    await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl }),
    );

    const afterReceive = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
        ],
      }),
    );

    expect(afterReceive.Attributes?.ApproximateNumberOfMessages).toBe("1");
    expect(afterReceive.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe(
      "1",
    );
  });

  it("receives system attributes via MessageSystemAttributeNames", async () => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "modern-attrs",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MessageSystemAttributeNames: ["SentTimestamp", "ApproximateReceiveCount"],
      }),
    );

    const attrs = received.Messages![0].Attributes;
    expect(attrs?.SentTimestamp).toBeDefined();
    expect(attrs?.ApproximateReceiveCount).toBe("1");
  });

  it("merges MessageSystemAttributeNames with AttributeNames", async () => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "merged-attrs",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["SenderId"],
        MessageSystemAttributeNames: ["SentTimestamp"],
      }),
    );

    const attrs = received.Messages![0].Attributes;
    expect(attrs?.SenderId).toBe("000000000000");
    expect(attrs?.SentTimestamp).toBeDefined();
  });

  it("rejects message with forbidden unicode characters", async () => {
    await expect(
      sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: "hello \uFFFF world",
        }),
      ),
    ).rejects.toThrow("Invalid characters");
  });

  it("accepts message with allowed special characters", async () => {
    const sent = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "tab\there\nnewline\rcarriage",
      }),
    );
    expect(sent.MessageId).toBeDefined();
  });

  it("rejects message exceeding 1 MiB size limit", async () => {
    const largeBody = "x".repeat(1_048_577); // 1 byte over limit
    await expect(
      sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: largeBody,
        }),
      ),
    ).rejects.toThrow("Message must be shorter than");
  });

  it("visibility timeout makes message reappear", async () => {
    // Create queue with very short visibility timeout
    const shortQueue = await sqs.send(
      new CreateQueueCommand({
        QueueName: `short-vis-${Date.now()}`,
        Attributes: { VisibilityTimeout: "1" },
      }),
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: shortQueue.QueueUrl!,
        MessageBody: "reappear",
      }),
    );

    // Receive the message
    await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: shortQueue.QueueUrl! }),
    );

    // Wait for visibility timeout to expire
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Message should be visible again
    const reappeared = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: shortQueue.QueueUrl! }),
    );
    expect(reappeared.Messages).toHaveLength(1);
    expect(reappeared.Messages![0].Body).toBe("reappear");
  });

  it("succeeds when deleting with a stale receipt handle after visibility expires", async () => {
    const shortQueue = await sqs.send(new CreateQueueCommand({
      QueueName: `stale-rh-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      Attributes: { VisibilityTimeout: "1" },
    }));
    await sqs.send(new SendMessageCommand({ QueueUrl: shortQueue.QueueUrl!, MessageBody: "stale test" }));
    const first = await sqs.send(new ReceiveMessageCommand({ QueueUrl: shortQueue.QueueUrl! }));
    const staleHandle = first.Messages![0].ReceiptHandle!;
    await new Promise(r => setTimeout(r, 1200));
    // Re-receive (gets new receipt handle)
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: shortQueue.QueueUrl! }));
    // Delete with stale handle — should succeed on standard queues
    await sqs.send(new DeleteMessageCommand({ QueueUrl: shortQueue.QueueUrl!, ReceiptHandle: staleHandle }));
  });

  it("succeeds when deleting the same receipt handle twice", async () => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "double-delete" }));
    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl }));
    const handle = received.Messages![0].ReceiptHandle!;
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: handle }));
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: handle }));
  });

  it("increments ApproximateReceiveCount on each receive", async () => {
    const shortQueue = await sqs.send(new CreateQueueCommand({
      QueueName: `recv-count-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      Attributes: { VisibilityTimeout: "1" },
    }));
    await sqs.send(new SendMessageCommand({ QueueUrl: shortQueue.QueueUrl!, MessageBody: "count me" }));
    const first = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: shortQueue.QueueUrl!,
      AttributeNames: ["ApproximateReceiveCount"],
    }));
    expect(first.Messages![0].Attributes?.ApproximateReceiveCount).toBe("1");
    await new Promise(r => setTimeout(r, 1200));
    const second = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: shortQueue.QueueUrl!,
      AttributeNames: ["ApproximateReceiveCount"],
    }));
    expect(second.Messages![0].Attributes?.ApproximateReceiveCount).toBe("2");
  });

  it("returns correct visible, inflight, and delayed counts via GetQueueAttributes", async () => {
    const q = await sqs.send(new CreateQueueCommand({
      QueueName: `counts-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      Attributes: { DelaySeconds: "900" },
    }));
    // Send 1 delayed message
    await sqs.send(new SendMessageCommand({ QueueUrl: q.QueueUrl!, MessageBody: "delayed" }));
    // Send 1 immediate message (override delay)
    await sqs.send(new SendMessageCommand({ QueueUrl: q.QueueUrl!, MessageBody: "immediate", DelaySeconds: 0 }));
    // Receive immediate message (moves to inflight)
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: q.QueueUrl! }));
    const attrs = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: q.QueueUrl!,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"],
    }));
    expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe("0");
    expect(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe("1");
    expect(attrs.Attributes?.ApproximateNumberOfMessagesDelayed).toBe("1");
  });

  it("preserves carriage return characters in message body", async () => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "line1\r\nline2\rline3" }));
    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl }));
    expect(received.Messages![0].Body).toBe("line1\r\nline2\rline3");
  });

  it("ChangeMessageVisibility extends timeout and message reappears after extended timeout", async () => {
    const q = await sqs.send(new CreateQueueCommand({
      QueueName: `vis-extend-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      Attributes: { VisibilityTimeout: "1" },
    }));
    await sqs.send(new SendMessageCommand({ QueueUrl: q.QueueUrl!, MessageBody: "extend-vis" }));
    const first = await sqs.send(new ReceiveMessageCommand({ QueueUrl: q.QueueUrl! }));
    // Extend visibility to 3 seconds
    await sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: q.QueueUrl!,
      ReceiptHandle: first.Messages![0].ReceiptHandle!,
      VisibilityTimeout: 3,
    }));
    // After 1.5s, message should still be invisible
    await new Promise(r => setTimeout(r, 1500));
    const still = await sqs.send(new ReceiveMessageCommand({ QueueUrl: q.QueueUrl! }));
    expect(still.Messages).toBeUndefined();
    // After another 2s (3.5s total), message should reappear
    await new Promise(r => setTimeout(r, 2000));
    const reappeared = await sqs.send(new ReceiveMessageCommand({ QueueUrl: q.QueueUrl! }));
    expect(reappeared.Messages).toHaveLength(1);
    expect(reappeared.Messages![0].Body).toBe("extend-vis");
  });

  it("ChangeMessageVisibility with timeout=0 makes message immediately available", async () => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "nack-me" }));
    const first = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl }));
    await sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: first.Messages![0].ReceiptHandle!,
      VisibilityTimeout: 0,
    }));
    const second = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl }));
    expect(second.Messages).toHaveLength(1);
    expect(second.Messages![0].Body).toBe("nack-me");
  });

  it("throws NonExistentQueue when sending to non-existent queue", async () => {
    await expect(
      sqs.send(new SendMessageCommand({
        QueueUrl: "http://sqs.us-east-1.localhost:9999/000000000000/does-not-exist",
        MessageBody: "test",
      }))
    ).rejects.toThrow(/does not exist/i);
  });

  it("rejects empty message body with MissingParameter", async () => {
    const res = await fetch(`http://localhost:${server.port}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": "AmazonSQS.SendMessage",
      },
      body: JSON.stringify({ QueueUrl: queueUrl, MessageBody: "" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.__type).toContain("MissingParameter");
  });

  it("handles ChangeMessageVisibility with invalid receipt handle gracefully", async () => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "vis-test" }));
    // ChangeMessageVisibility with a bogus handle — fauxqs rejects with MessageNotInflight
    await expect(
      sqs.send(new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: "invalid-handle-12345",
        VisibilityTimeout: 30,
      }))
    ).rejects.toThrow(/not available for visibility timeout change/i);
  });
});
