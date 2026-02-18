import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { createTestServer, type TestServer } from "../helpers/setup.js";

describe("SQS Dead Letter Queue", () => {
  let server: TestServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await createTestServer();
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.app.close();
  });

  it("moves messages to DLQ after maxReceiveCount", async () => {
    // Create DLQ
    const dlq = await sqs.send(
      new CreateQueueCommand({ QueueName: "my-dlq" }),
    );
    const dlqAttrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlq.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );

    // Create source queue with RedrivePolicy, short visibility timeout
    const source = await sqs.send(
      new CreateQueueCommand({
        QueueName: "source-queue",
        Attributes: { VisibilityTimeout: "1" },
      }),
    );

    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: source.QueueUrl!,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqAttrs.Attributes!.QueueArn,
            maxReceiveCount: 2,
          }),
        },
      }),
    );

    // Send a message
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: source.QueueUrl!,
        MessageBody: "dlq test message",
      }),
    );

    // Receive 1st time
    await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }),
    );
    await new Promise((r) => setTimeout(r, 1200));

    // Receive 2nd time
    await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }),
    );
    await new Promise((r) => setTimeout(r, 1200));

    // 3rd receive should trigger DLQ move (receiveCount now 3 > maxReceiveCount 2)
    const thirdReceive = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }),
    );
    // Message should have been moved to DLQ, so source returns empty
    expect(thirdReceive.Messages).toBeUndefined();

    // Check DLQ has the message
    const dlqMessages = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlq.QueueUrl! }),
    );
    expect(dlqMessages.Messages).toHaveLength(1);
    expect(dlqMessages.Messages![0].Body).toBe("dlq test message");
  });
});
