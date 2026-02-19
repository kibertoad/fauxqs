import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  PurgeQueueCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS PurgeQueue", () => {
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
        QueueName: `purge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        Attributes: { VisibilityTimeout: "30" },
      }),
    );
    queueUrl = result.QueueUrl!;
  });

  it("purges available messages", async () => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "msg1" }));
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "msg2" }));

    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));

    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl }));
    expect(received.Messages).toBeUndefined();
  });

  it("purges inflight messages", async () => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "inflight-msg" }));

    // Receive the message (makes it inflight)
    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl }));
    expect(received.Messages).toHaveLength(1);

    // Verify it's inflight
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessagesNotVisible"],
      }),
    );
    expect(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe("1");

    // Purge
    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));

    // Inflight count should be 0
    const attrsAfter = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: [
          "ApproximateNumberOfMessages",
          "ApproximateNumberOfMessagesNotVisible",
        ],
      }),
    );
    expect(attrsAfter.Attributes?.ApproximateNumberOfMessages).toBe("0");
    expect(attrsAfter.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe("0");
  });

  it("purges delayed messages", async () => {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "delayed-msg",
        DelaySeconds: 900,
      }),
    );

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessagesDelayed"],
      }),
    );
    expect(attrs.Attributes?.ApproximateNumberOfMessagesDelayed).toBe("1");

    await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));

    const attrsAfter = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessagesDelayed"],
      }),
    );
    expect(attrsAfter.Attributes?.ApproximateNumberOfMessagesDelayed).toBe("0");
  });
});
