import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS Binary Message Attributes", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;
  let queueUrl: string;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
    const result = await sqs.send(
      new CreateQueueCommand({ QueueName: "binary-attr-queue" }),
    );
    queueUrl = result.QueueUrl!;
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("sends and receives a message with Binary attribute", async () => {
    const binaryData = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

    const sent = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "binary test",
        MessageAttributes: {
          BinaryAttr: {
            DataType: "Binary",
            BinaryValue: binaryData,
          },
        },
      }),
    );

    expect(sent.MD5OfMessageAttributes).toBeDefined();
    expect(sent.MD5OfMessageAttributes!.length).toBe(32);

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MessageAttributeNames: ["All"],
      }),
    );

    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].MessageAttributes?.BinaryAttr).toBeDefined();
    expect(received.Messages![0].MD5OfMessageAttributes).toBe(
      sent.MD5OfMessageAttributes,
    );
  });

  it("computes correct MD5 for mixed String and Binary attributes", async () => {
    const sent = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "mixed attributes test",
        MessageAttributes: {
          StringAttr: {
            DataType: "String",
            StringValue: "hello",
          },
          BinaryAttr: {
            DataType: "Binary",
            BinaryValue: new Uint8Array([1, 2, 3]),
          },
        },
      }),
    );

    expect(sent.MD5OfMessageAttributes).toBeDefined();
    expect(sent.MD5OfMessageAttributes!.length).toBe(32);

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MessageAttributeNames: ["All"],
      }),
    );

    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].MD5OfMessageAttributes).toBe(
      sent.MD5OfMessageAttributes,
    );
  });
});
