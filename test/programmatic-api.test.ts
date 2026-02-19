import { describe, it, expect, afterEach } from "vitest";
import { startFauxqs, type FauxqsServer } from "../src/app.js";
import { createSqsClient, createSnsClient, createS3Client } from "./helpers/clients.js";
import {
  ListQueuesCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { ListTopicsCommand, ListSubscriptionsCommand, PublishCommand } from "@aws-sdk/client-sns";
import {
  ListBucketsCommand,
} from "@aws-sdk/client-s3";

describe("programmatic API", () => {
  let server: FauxqsServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it("createQueue makes queue visible via SDK", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.createQueue("prog-queue");

    const sqs = createSqsClient(server.port);
    const result = await sqs.send(new ListQueuesCommand({}));
    expect(result.QueueUrls).toHaveLength(1);
    expect(result.QueueUrls![0]).toContain("prog-queue");
  });

  it("createQueue with attributes and tags", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.createQueue("prog-queue-attrs", {
      attributes: { VisibilityTimeout: "120" },
      tags: { team: "platform" },
    });

    const sqs = createSqsClient(server.port);
    const result = await sqs.send(new ListQueuesCommand({}));
    expect(result.QueueUrls).toHaveLength(1);
  });

  it("createTopic makes topic visible via SDK", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.createTopic("prog-topic");

    const sns = createSnsClient(server.port);
    const result = await sns.send(new ListTopicsCommand({}));
    expect(result.Topics).toHaveLength(1);
    expect(result.Topics![0].TopicArn).toContain("prog-topic");
  });

  it("createTopic with attributes and tags", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.createTopic("prog-topic-attrs", {
      attributes: { DisplayName: "My Topic" },
      tags: { team: "platform" },
    });

    const sns = createSnsClient(server.port);
    const result = await sns.send(new ListTopicsCommand({}));
    expect(result.Topics).toHaveLength(1);
  });

  it("subscribe wires topic to queue", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.createQueue("sub-q");
    server.createTopic("sub-t");
    server.subscribe({ topic: "sub-t", queue: "sub-q" });

    const sns = createSnsClient(server.port);
    const subs = await sns.send(new ListSubscriptionsCommand({}));
    expect(subs.Subscriptions).toHaveLength(1);
    expect(subs.Subscriptions![0].Protocol).toBe("sqs");

    // Verify end-to-end: publish → receive
    await sns.send(
      new PublishCommand({
        TopicArn: "arn:aws:sns:us-east-1:000000000000:sub-t",
        Message: "programmatic test",
      }),
    );

    const sqs = createSqsClient(server.port);
    const queues = await sqs.send(new ListQueuesCommand({}));
    const msgs = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.QueueUrls![0],
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }),
    );
    expect(msgs.Messages).toHaveLength(1);
    expect(msgs.Messages![0].Body).toContain("programmatic test");
  });

  it("createBucket makes bucket visible via SDK", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.createBucket("prog-bucket");

    const s3 = createS3Client(server.port);
    const result = await s3.send(new ListBucketsCommand({}));
    expect(result.Buckets).toHaveLength(1);
    expect(result.Buckets![0].Name).toBe("prog-bucket");
  });

  it("setup creates all resources from config", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.setup({
      queues: [{ name: "setup-q1" }, { name: "setup-q2" }],
      topics: [{ name: "setup-t1" }],
      subscriptions: [{ topic: "setup-t1", queue: "setup-q1" }],
      buckets: ["setup-b1", "setup-b2"],
    });

    const sqs = createSqsClient(server.port);
    const sns = createSnsClient(server.port);
    const s3 = createS3Client(server.port);

    const queues = await sqs.send(new ListQueuesCommand({}));
    expect(queues.QueueUrls).toHaveLength(2);

    const topics = await sns.send(new ListTopicsCommand({}));
    expect(topics.Topics).toHaveLength(1);

    const subs = await sns.send(new ListSubscriptionsCommand({}));
    expect(subs.Subscriptions).toHaveLength(1);

    const buckets = await s3.send(new ListBucketsCommand({}));
    expect(buckets.Buckets).toHaveLength(2);
  });

  it("purgeAll clears all resources", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.createQueue("purge-q");
    server.createTopic("purge-t");
    server.createBucket("purge-b");

    server.purgeAll();

    const sqs = createSqsClient(server.port);
    const sns = createSnsClient(server.port);
    const s3 = createS3Client(server.port);

    const queues = await sqs.send(new ListQueuesCommand({}));
    expect(queues.QueueUrls ?? []).toHaveLength(0);

    const topics = await sns.send(new ListTopicsCommand({}));
    expect(topics.Topics ?? []).toHaveLength(0);

    const buckets = await s3.send(new ListBucketsCommand({}));
    expect(buckets.Buckets ?? []).toHaveLength(0);
  });

  it("purgeAll then recreate works", async () => {
    server = await startFauxqs({ port: 0, logger: false });
    server.createQueue("first-q");
    server.purgeAll();
    server.createQueue("second-q");

    const sqs = createSqsClient(server.port);
    const queues = await sqs.send(new ListQueuesCommand({}));
    expect(queues.QueueUrls).toHaveLength(1);
    expect(queues.QueueUrls![0]).toContain("second-q");
  });
});
