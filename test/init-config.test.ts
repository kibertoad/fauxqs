import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFauxqs, type FauxqsServer } from "../src/app.js";
import { createSqsClient, createSnsClient, createS3Client } from "./helpers/clients.js";
import {
  ListQueuesCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { ListTopicsCommand, PublishCommand } from "@aws-sdk/client-sns";
import {
  ListBucketsCommand,
} from "@aws-sdk/client-s3";
import { loadInitConfig, validateInitConfig } from "../src/initConfig.js";

describe("init config", () => {
  let server: FauxqsServer;
  let tmpDir: string;

  afterEach(async () => {
    if (server) await server.stop();
  });

  function writeTempConfig(config: object): string {
    tmpDir = mkdtempSync(join(tmpdir(), "fauxqs-"));
    const path = join(tmpDir, "init.json");
    writeFileSync(path, JSON.stringify(config));
    return path;
  }

  function cleanupTempConfig(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }

  it("loadInitConfig reads and parses a JSON file", () => {
    const path = writeTempConfig({
      queues: [{ name: "q1" }],
      topics: [{ name: "t1" }],
      buckets: ["b1"],
    });

    const config = loadInitConfig(path);
    expect(config.queues).toEqual([{ name: "q1" }]);
    expect(config.topics).toEqual([{ name: "t1" }]);
    expect(config.buckets).toEqual(["b1"]);

    cleanupTempConfig(path);
  });

  it("loadInitConfig throws for missing file", () => {
    expect(() => loadInitConfig("/nonexistent/path.json")).toThrow();
  });

  it("loadInitConfig throws for invalid JSON", () => {
    const path = writeTempConfig({});
    writeFileSync(path, "not valid json {{{");
    expect(() => loadInitConfig(path)).toThrow();
    cleanupTempConfig(path);
  });

  it("validateInitConfig rejects non-object input", () => {
    expect(() => validateInitConfig("not an object")).toThrow();
    expect(() => validateInitConfig(42)).toThrow();
    expect(() => validateInitConfig(null)).toThrow();
  });

  it("validateInitConfig rejects queues with missing name", () => {
    expect(() => validateInitConfig({ queues: [{}] })).toThrow();
  });

  it("validateInitConfig rejects queues with wrong type for name", () => {
    expect(() => validateInitConfig({ queues: [{ name: 123 }] })).toThrow();
  });

  it("validateInitConfig rejects buckets with wrong element type", () => {
    expect(() => validateInitConfig({ buckets: [123] })).toThrow();
  });

  it("validateInitConfig rejects subscriptions with missing fields", () => {
    expect(() => validateInitConfig({ subscriptions: [{ topic: "t1" }] })).toThrow();
    expect(() => validateInitConfig({ subscriptions: [{ queue: "q1" }] })).toThrow();
  });

  it("validateInitConfig accepts empty config", () => {
    const config = validateInitConfig({});
    expect(config).toEqual({});
  });

  it("validateInitConfig accepts valid full config", () => {
    const config = validateInitConfig({
      queues: [{ name: "q1", attributes: { VisibilityTimeout: "30" }, tags: { env: "dev" } }],
      topics: [{ name: "t1" }],
      subscriptions: [{ topic: "t1", queue: "q1" }],
      buckets: ["b1"],
    });
    expect(config.queues).toHaveLength(1);
    expect(config.topics).toHaveLength(1);
    expect(config.subscriptions).toHaveLength(1);
    expect(config.buckets).toEqual(["b1"]);
  });

  it("loadInitConfig rejects file with invalid structure", () => {
    const path = writeTempConfig({ queues: "not-an-array" });
    expect(() => loadInitConfig(path)).toThrow();
    cleanupTempConfig(path);
  });

  it("applies init config from file path on startup", async () => {
    const configPath = writeTempConfig({
      queues: [{ name: "init-queue" }],
      topics: [{ name: "init-topic" }],
      buckets: ["init-bucket"],
    });

    server = await startFauxqs({ port: 0, logger: false, init: configPath });
    const sqs = createSqsClient(server.port);
    const sns = createSnsClient(server.port);
    const s3 = createS3Client(server.port);

    const queues = await sqs.send(new ListQueuesCommand({}));
    expect(queues.QueueUrls).toHaveLength(1);
    expect(queues.QueueUrls![0]).toContain("init-queue");

    const topics = await sns.send(new ListTopicsCommand({}));
    expect(topics.Topics).toHaveLength(1);
    expect(topics.Topics![0].TopicArn).toContain("init-topic");

    const buckets = await s3.send(new ListBucketsCommand({}));
    expect(buckets.Buckets).toHaveLength(1);
    expect(buckets.Buckets![0].Name).toBe("init-bucket");

    cleanupTempConfig(configPath);
  });

  it("applies init config from inline object", async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      init: {
        queues: [{ name: "inline-queue" }],
        topics: [{ name: "inline-topic" }],
        buckets: ["inline-bucket"],
      },
    });

    const sqs = createSqsClient(server.port);
    const sns = createSnsClient(server.port);
    const s3 = createS3Client(server.port);

    const queues = await sqs.send(new ListQueuesCommand({}));
    expect(queues.QueueUrls).toHaveLength(1);

    const topics = await sns.send(new ListTopicsCommand({}));
    expect(topics.Topics).toHaveLength(1);

    const buckets = await s3.send(new ListBucketsCommand({}));
    expect(buckets.Buckets).toHaveLength(1);
  });

  it("creates subscriptions that wire topics to queues", async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      init: {
        queues: [{ name: "sub-queue" }],
        topics: [{ name: "sub-topic" }],
        subscriptions: [{ topic: "sub-topic", queue: "sub-queue" }],
      },
    });

    const sqs = createSqsClient(server.port);
    const sns = createSnsClient(server.port);

    // Publish to the topic
    await sns.send(
      new PublishCommand({
        TopicArn: "arn:aws:sns:us-east-1:000000000000:sub-topic",
        Message: "hello from init",
      }),
    );

    // Receive from the queue
    const queues = await sqs.send(new ListQueuesCommand({}));
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.QueueUrls![0],
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }),
    );

    expect(result.Messages).toHaveLength(1);
    expect(result.Messages![0].Body).toContain("hello from init");
  });

  it("creates queues with attributes and tags", async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      init: {
        queues: [
          {
            name: "attr-queue",
            attributes: { VisibilityTimeout: "60", DelaySeconds: "5" },
            tags: { env: "test" },
          },
        ],
      },
    });

    const sqs = createSqsClient(server.port);
    const queues = await sqs.send(new ListQueuesCommand({}));
    expect(queues.QueueUrls).toHaveLength(1);
    expect(queues.QueueUrls![0]).toContain("attr-queue");
  });
});
