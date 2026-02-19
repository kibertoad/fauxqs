import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  PurgeQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, startFauxqsTestServerWithHost, type FauxqsServer } from "../helpers/setup.js";
import { SqsStore } from "../../src/sqs/sqsStore.js";

describe("SQS Queue Management", () => {
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

  it("creates a queue and returns its URL", async () => {
    const result = await sqs.send(
      new CreateQueueCommand({ QueueName: "test-queue" }),
    );
    expect(result.QueueUrl).toContain("test-queue");
    expect(result.QueueUrl).toContain("000000000000");
  });

  it("is idempotent for same name and attributes", async () => {
    const result1 = await sqs.send(
      new CreateQueueCommand({ QueueName: "idempotent-queue" }),
    );
    const result2 = await sqs.send(
      new CreateQueueCommand({ QueueName: "idempotent-queue" }),
    );
    expect(result1.QueueUrl).toBe(result2.QueueUrl);
  });

  it("gets queue URL by name", async () => {
    const created = await sqs.send(
      new CreateQueueCommand({ QueueName: "url-lookup-queue" }),
    );
    const result = await sqs.send(
      new GetQueueUrlCommand({ QueueName: "url-lookup-queue" }),
    );
    expect(result.QueueUrl).toBe(created.QueueUrl);
  });

  it("lists queues", async () => {
    await sqs.send(
      new CreateQueueCommand({ QueueName: "list-queue-a" }),
    );
    await sqs.send(
      new CreateQueueCommand({ QueueName: "list-queue-b" }),
    );

    const result = await sqs.send(new ListQueuesCommand({}));
    const urls = result.QueueUrls ?? [];
    expect(urls.some((u) => u.includes("list-queue-a"))).toBe(true);
    expect(urls.some((u) => u.includes("list-queue-b"))).toBe(true);
  });

  it("lists queues with prefix filter", async () => {
    await sqs.send(
      new CreateQueueCommand({ QueueName: "prefix-alpha" }),
    );
    await sqs.send(
      new CreateQueueCommand({ QueueName: "prefix-beta" }),
    );
    await sqs.send(
      new CreateQueueCommand({ QueueName: "other-queue" }),
    );

    const result = await sqs.send(
      new ListQueuesCommand({ QueueNamePrefix: "prefix-" }),
    );
    const urls = result.QueueUrls ?? [];
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(urls.every((u) => u.includes("prefix-"))).toBe(true);
  });

  it("gets queue attributes", async () => {
    const created = await sqs.send(
      new CreateQueueCommand({
        QueueName: "attr-queue",
        Attributes: { VisibilityTimeout: "60" },
      }),
    );

    const result = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: created.QueueUrl,
        AttributeNames: ["All"],
      }),
    );

    expect(result.Attributes?.VisibilityTimeout).toBe("60");
    expect(result.Attributes?.QueueArn).toContain("attr-queue");
    expect(result.Attributes?.DelaySeconds).toBe("0");
  });

  it("sets queue attributes", async () => {
    const created = await sqs.send(
      new CreateQueueCommand({ QueueName: "set-attr-queue" }),
    );

    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: created.QueueUrl,
        Attributes: { VisibilityTimeout: "120" },
      }),
    );

    const result = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: created.QueueUrl,
        AttributeNames: ["VisibilityTimeout"],
      }),
    );

    expect(result.Attributes?.VisibilityTimeout).toBe("120");
  });

  it("deletes a queue", async () => {
    const created = await sqs.send(
      new CreateQueueCommand({ QueueName: "delete-me-queue" }),
    );

    await sqs.send(
      new DeleteQueueCommand({ QueueUrl: created.QueueUrl }),
    );

    // Queue should no longer be listable
    const list = await sqs.send(new ListQueuesCommand({}));
    const urls = list.QueueUrls ?? [];
    expect(urls.some((u) => u.includes("delete-me-queue"))).toBe(false);
  });

  it("creates queue with custom attributes", async () => {
    const result = await sqs.send(
      new CreateQueueCommand({
        QueueName: "custom-attrs-queue",
        Attributes: {
          DelaySeconds: "5",
          MaximumMessageSize: "1024",
          MessageRetentionPeriod: "86400",
          ReceiveMessageWaitTimeSeconds: "10",
        },
      }),
    );

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: result.QueueUrl,
        AttributeNames: ["All"],
      }),
    );

    expect(attrs.Attributes?.DelaySeconds).toBe("5");
    expect(attrs.Attributes?.MaximumMessageSize).toBe("1024");
    expect(attrs.Attributes?.MessageRetentionPeriod).toBe("86400");
    expect(attrs.Attributes?.ReceiveMessageWaitTimeSeconds).toBe("10");
  });

  it("purges a queue", async () => {
    const created = await sqs.send(
      new CreateQueueCommand({ QueueName: "purge-queue" }),
    );

    await sqs.send(
      new PurgeQueueCommand({ QueueUrl: created.QueueUrl }),
    );

    // Should succeed without error (queue is empty, purge is still valid)
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: created.QueueUrl,
        AttributeNames: ["ApproximateNumberOfMessages"],
      }),
    );
    expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe("0");
  });

  it("creates and updates KMS attributes", async () => {
    const created = await sqs.send(
      new CreateQueueCommand({
        QueueName: "kms-queue",
        Attributes: {
          KmsMasterKeyId: "alias/my-key",
          KmsDataKeyReusePeriodSeconds: "300",
        },
      }),
    );

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: created.QueueUrl,
        AttributeNames: ["All"],
      }),
    );
    expect(attrs.Attributes?.KmsMasterKeyId).toBe("alias/my-key");
    expect(attrs.Attributes?.KmsDataKeyReusePeriodSeconds).toBe("300");

    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: created.QueueUrl,
        Attributes: { KmsMasterKeyId: "alias/other-key" },
      }),
    );

    const updated = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: created.QueueUrl,
        AttributeNames: ["KmsMasterKeyId"],
      }),
    );
    expect(updated.Attributes?.KmsMasterKeyId).toBe("alias/other-key");
  });
});

describe("SQS Queue URL with configured host", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startFauxqsTestServerWithHost("localhost");
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("returns queue URL in sqs.<region>.<host> format", async () => {
    const result = await sqs.send(
      new CreateQueueCommand({ QueueName: "host-test-queue" }),
    );
    expect(result.QueueUrl).toBe(
      `http://sqs.us-east-1.localhost:${server.port}/000000000000/host-test-queue`,
    );
  });

  it("operations work with configured host URLs", async () => {
    const created = await sqs.send(
      new CreateQueueCommand({ QueueName: "host-ops-queue" }),
    );

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: created.QueueUrl,
        AttributeNames: ["All"],
      }),
    );
    expect(attrs.Attributes?.QueueArn).toContain("host-ops-queue");
  });
});

describe("SQS region auto-detection from SDK", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startFauxqsTestServerWithHost("localhost");
    sqs = createSqsClient(server.port, "eu-west-1");
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("uses region from SDK Authorization header in ARNs and URLs", async () => {
    const result = await sqs.send(
      new CreateQueueCommand({ QueueName: "region-auto-queue" }),
    );
    expect(result.QueueUrl).toBe(
      `http://sqs.eu-west-1.localhost:${server.port}/000000000000/region-auto-queue`,
    );

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: result.QueueUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    expect(attrs.Attributes?.QueueArn).toBe(
      "arn:aws:sqs:eu-west-1:000000000000:region-auto-queue",
    );
  });
});

describe("SqsStore.buildQueueUrl", () => {
  it("uses configured host regardless of request Host header", () => {
    const store = new SqsStore();
    store.host = "localhost";

    const fromLocalhost = store.buildQueueUrl("my-queue", "4566", "127.0.0.1:4566", "us-east-1");
    const fromDocker = store.buildQueueUrl("my-queue", "4566", "fauxqs:4566", "us-east-1");
    const fromOther = store.buildQueueUrl("my-queue", "4566", "some-host:4566", "us-east-1");

    expect(fromLocalhost).toBe("http://sqs.us-east-1.localhost:4566/000000000000/my-queue");
    expect(fromDocker).toBe(fromLocalhost);
    expect(fromOther).toBe(fromLocalhost);
  });

  it("defaults host to localhost when not explicitly configured", () => {
    const store = new SqsStore();

    const url = store.buildQueueUrl("my-queue", "4566", "127.0.0.1:4566", "us-east-1");

    expect(url).toBe("http://sqs.us-east-1.localhost:4566/000000000000/my-queue");
  });
});

describe("SQS Queue URL consistency across creation paths", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startFauxqsTestServerWithHost("localhost");
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("queue created via init config has same URL format as queue created via SDK", async () => {
    // Simulate Docker FAUXQS_INIT: queue pre-created at startup
    server.setup({
      queues: [{ name: "init-config-queue" }],
    });

    // SDK creates a different queue — SDK connects to 127.0.0.1:PORT,
    // so its Host header differs from the configured host ("localhost")
    const sdkResult = await sqs.send(
      new CreateQueueCommand({ QueueName: "sdk-created-queue" }),
    );

    // Both URLs must use the configured host format
    const expectedPrefix = `http://sqs.us-east-1.localhost:${server.port}/000000000000/`;

    const initQueueUrl = (
      await sqs.send(new GetQueueUrlCommand({ QueueName: "init-config-queue" }))
    ).QueueUrl!;

    expect(initQueueUrl).toBe(`${expectedPrefix}init-config-queue`);
    expect(sdkResult.QueueUrl).toBe(`${expectedPrefix}sdk-created-queue`);
  });

  it("queue from init config is accessible for send/receive via SDK", async () => {
    server.setup({
      queues: [{ name: "init-ops-queue" }],
    });

    const queueUrl = (
      await sqs.send(new GetQueueUrlCommand({ QueueName: "init-ops-queue" }))
    ).QueueUrl!;

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "hello from docker",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
      }),
    );

    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("hello from docker");
  });

  it("SDK CreateQueue is idempotent with init-config-created queue", async () => {
    server.setup({
      queues: [{ name: "idempotent-init-queue" }],
    });

    // SDK calls CreateQueue with the same name — should return the same URL
    const result = await sqs.send(
      new CreateQueueCommand({ QueueName: "idempotent-init-queue" }),
    );

    expect(result.QueueUrl).toBe(
      `http://sqs.us-east-1.localhost:${server.port}/000000000000/idempotent-init-queue`,
    );
  });
});
