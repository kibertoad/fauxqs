import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS ReceiveMessage MessageAttributeNames filtering", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;
  let queueUrl: string;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
    const result = await sqs.send(
      new CreateQueueCommand({
        QueueName: "msg-attr-filter-queue",
        Attributes: { VisibilityTimeout: "0" },
      }),
    );
    queueUrl = result.QueueUrl!;

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "test",
        MessageAttributes: {
          color: { DataType: "String", StringValue: "red" },
          size: { DataType: "Number", StringValue: "42" },
          shape: { DataType: "String", StringValue: "circle" },
        },
      }),
    );
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("returns only requested message attributes", async () => {
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MessageAttributeNames: ["color"],
      }),
    );

    const attrs = result.Messages![0].MessageAttributes!;
    expect(attrs.color).toBeDefined();
    expect(attrs.color.StringValue).toBe("red");
    expect(attrs.size).toBeUndefined();
    expect(attrs.shape).toBeUndefined();
  });

  it("returns multiple requested attributes", async () => {
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MessageAttributeNames: ["color", "shape"],
      }),
    );

    const attrs = result.Messages![0].MessageAttributes!;
    expect(attrs.color).toBeDefined();
    expect(attrs.shape).toBeDefined();
    expect(attrs.size).toBeUndefined();
  });

  it("returns all attributes when All is specified", async () => {
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MessageAttributeNames: ["All"],
      }),
    );

    const attrs = result.Messages![0].MessageAttributes!;
    expect(attrs.color).toBeDefined();
    expect(attrs.size).toBeDefined();
    expect(attrs.shape).toBeDefined();
  });

  it("returns all attributes when .* is specified", async () => {
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MessageAttributeNames: [".*"],
      }),
    );

    const attrs = result.Messages![0].MessageAttributes!;
    expect(attrs.color).toBeDefined();
    expect(attrs.size).toBeDefined();
    expect(attrs.shape).toBeDefined();
  });

  it("returns no MessageAttributes when requested names don't match", async () => {
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MessageAttributeNames: ["nonexistent"],
      }),
    );

    expect(result.Messages![0].MessageAttributes).toBeUndefined();
  });

  it("returns all attributes when MessageAttributeNames is not specified", async () => {
    const result = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl }),
    );

    const attrs = result.Messages![0].MessageAttributes!;
    expect(attrs.color).toBeDefined();
    expect(attrs.size).toBeDefined();
    expect(attrs.shape).toBeDefined();
  });
});

describe("SQS ReceiveMessage MessageAttributeNames prefix pattern", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;
  let queueUrl: string;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
    const result = await sqs.send(
      new CreateQueueCommand({
        QueueName: "msg-attr-prefix-queue",
        Attributes: { VisibilityTimeout: "0" },
      }),
    );
    queueUrl = result.QueueUrl!;

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "test",
        MessageAttributes: {
          "payloadOffloading.size": { DataType: "Number", StringValue: "1024" },
          "payloadOffloading.store": { DataType: "String", StringValue: "s3" },
          "other.attr": { DataType: "String", StringValue: "val" },
          plain: { DataType: "String", StringValue: "hello" },
        },
      }),
    );
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("returns attributes matching prefix pattern (prefix.*)", async () => {
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MessageAttributeNames: ["payloadOffloading.*"],
      }),
    );

    const attrs = result.Messages![0].MessageAttributes!;
    expect(attrs["payloadOffloading.size"]).toBeDefined();
    expect(attrs["payloadOffloading.size"].StringValue).toBe("1024");
    expect(attrs["payloadOffloading.store"]).toBeDefined();
    expect(attrs["payloadOffloading.store"].StringValue).toBe("s3");
    expect(attrs["other.attr"]).toBeUndefined();
    expect(attrs["plain"]).toBeUndefined();
  });

  it("combines prefix patterns with exact names", async () => {
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MessageAttributeNames: ["payloadOffloading.*", "plain"],
      }),
    );

    const attrs = result.Messages![0].MessageAttributes!;
    expect(attrs["payloadOffloading.size"]).toBeDefined();
    expect(attrs["payloadOffloading.store"]).toBeDefined();
    expect(attrs["plain"]).toBeDefined();
    expect(attrs["other.attr"]).toBeUndefined();
  });

  it("prefix pattern does not match unrelated attributes", async () => {
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MessageAttributeNames: ["nonexistent.*"],
      }),
    );

    expect(result.Messages![0].MessageAttributes).toBeUndefined();
  });
});
