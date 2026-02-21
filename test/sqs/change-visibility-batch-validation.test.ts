import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  ChangeMessageVisibilityBatchCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("ChangeMessageVisibilityBatch VisibilityTimeout validation", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;
  let queueUrl: string;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
    const result = await sqs.send(
      new CreateQueueCommand({ QueueName: "vis-batch-val-queue" }),
    );
    queueUrl = result.QueueUrl!;
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("returns Failed entry for negative VisibilityTimeout", async () => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "msg1" }));
    const recv = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1 }),
    );

    const result = await sqs.send(
      new ChangeMessageVisibilityBatchCommand({
        QueueUrl: queueUrl,
        Entries: [
          {
            Id: "entry-neg",
            ReceiptHandle: recv.Messages![0].ReceiptHandle!,
            VisibilityTimeout: -1,
          },
        ],
      }),
    );

    expect(result.Failed).toHaveLength(1);
    expect(result.Failed![0].Code).toBe("InvalidParameterValue");
    expect(result.Failed![0].SenderFault).toBe(true);
    expect(result.Successful).toHaveLength(0);
  });

  it("returns Failed entry for VisibilityTimeout > 43200", async () => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "msg2" }));
    const recv = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1 }),
    );

    const result = await sqs.send(
      new ChangeMessageVisibilityBatchCommand({
        QueueUrl: queueUrl,
        Entries: [
          {
            Id: "entry-over",
            ReceiptHandle: recv.Messages![0].ReceiptHandle!,
            VisibilityTimeout: 50000,
          },
        ],
      }),
    );

    expect(result.Failed).toHaveLength(1);
    expect(result.Failed![0].Code).toBe("InvalidParameterValue");
    expect(result.Successful).toHaveLength(0);
  });

  it("mixed batch: valid entry succeeds, invalid entry fails", async () => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "msg3a" }));
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "msg3b" }));
    const recv = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 2 }),
    );

    const result = await sqs.send(
      new ChangeMessageVisibilityBatchCommand({
        QueueUrl: queueUrl,
        Entries: [
          {
            Id: "valid-entry",
            ReceiptHandle: recv.Messages![0].ReceiptHandle!,
            VisibilityTimeout: 60,
          },
          {
            Id: "invalid-entry",
            ReceiptHandle: recv.Messages![1].ReceiptHandle!,
            VisibilityTimeout: 99999,
          },
        ],
      }),
    );

    expect(result.Successful).toHaveLength(1);
    expect(result.Successful![0].Id).toBe("valid-entry");
    expect(result.Failed).toHaveLength(1);
    expect(result.Failed![0].Id).toBe("invalid-entry");
    expect(result.Failed![0].Code).toBe("InvalidParameterValue");
  });
});
