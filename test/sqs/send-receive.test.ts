import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
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
    expect(received.Messages![0].ReceiptHandle).toBeDefined();
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
});
