import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { startFauxqsTestServerWithHost, type FauxqsServer } from "../helpers/setup.js";

/**
 * Reproduces the exact scenario from message-queue-toolkit:
 * - fauxqs started with host: 'localstack'
 * - SQS client endpoint: 'http://localhost:PORT' (not 127.0.0.1)
 * - region: 'eu-west-1'
 * - Queue URLs must use the configured host 'localstack', not the request host 'localhost'
 */
describe("SQS custom host (message-queue-toolkit scenario)", () => {
  let server: FauxqsServer;
  let sqs: SQSClient;

  beforeAll(async () => {
    // Same as message-queue-toolkit globalSetup.ts:
    // startFauxqs({ port: 4566, logger: false, host: 'localstack' })
    server = await startFauxqsTestServerWithHost("localstack");

    // Same as message-queue-toolkit testAwsConfig.ts:
    // endpoint: 'http://localhost:4566', region: 'eu-west-1'
    sqs = new SQSClient({
      endpoint: `http://localhost:${server.port}`,
      region: "eu-west-1",
      credentials: { accessKeyId: "access", secretAccessKey: "secret" },
    });
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("CreateQueue returns URL with configured host 'localstack'", async () => {
    const result = await sqs.send(
      new CreateQueueCommand({ QueueName: "someQueue" }),
    );
    // message-queue-toolkit expects:
    // http://sqs.eu-west-1.localstack:4566/000000000000/someQueue
    expect(result.QueueUrl).toBe(
      `http://sqs.eu-west-1.localstack:${server.port}/000000000000/someQueue`,
    );
  });

  it("GetQueueUrl returns URL with configured host 'localstack'", async () => {
    await sqs.send(new CreateQueueCommand({ QueueName: "getUrlQueue" }));

    const result = await sqs.send(
      new GetQueueUrlCommand({ QueueName: "getUrlQueue" }),
    );
    expect(result.QueueUrl).toBe(
      `http://sqs.eu-west-1.localstack:${server.port}/000000000000/getUrlQueue`,
    );
  });

  it("GetQueueAttributes returns correct ARN with eu-west-1 region", async () => {
    const created = await sqs.send(
      new CreateQueueCommand({ QueueName: "arnQueue" }),
    );

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: created.QueueUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    expect(attrs.Attributes?.QueueArn).toBe(
      "arn:aws:sqs:eu-west-1:000000000000:arnQueue",
    );
  });

  it("send/receive works with the localstack URL", async () => {
    const created = await sqs.send(
      new CreateQueueCommand({ QueueName: "opsQueue" }),
    );

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: created.QueueUrl,
        MessageBody: "test message",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: created.QueueUrl,
        MaxNumberOfMessages: 1,
      }),
    );
    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("test message");
  });

  it("CreateQueue idempotent with queue from programmatic API", async () => {
    server.createQueue("progQueue", { region: "eu-west-1" });

    const result = await sqs.send(
      new CreateQueueCommand({ QueueName: "progQueue" }),
    );
    expect(result.QueueUrl).toBe(
      `http://sqs.eu-west-1.localstack:${server.port}/000000000000/progQueue`,
    );
  });

  it("init config queue accessible via SDK with localstack URL", async () => {
    server.setup({
      queues: [{ name: "initQueue", region: "eu-west-1" }],
    });

    const result = await sqs.send(
      new GetQueueUrlCommand({ QueueName: "initQueue" }),
    );
    expect(result.QueueUrl).toBe(
      `http://sqs.eu-west-1.localstack:${server.port}/000000000000/initQueue`,
    );
  });

  it("queue region in URL matches region in ARN", async () => {
    server.createQueue("regionQueue", { region: "eu-west-1" });

    const urlResult = await sqs.send(
      new GetQueueUrlCommand({ QueueName: "regionQueue" }),
    );

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: urlResult.QueueUrl,
        AttributeNames: ["QueueArn"],
      }),
    );

    expect(urlResult.QueueUrl).toContain("sqs.eu-west-1.localstack");
    expect(attrs.Attributes?.QueueArn).toBe(
      "arn:aws:sqs:eu-west-1:000000000000:regionQueue",
    );
  });
});
