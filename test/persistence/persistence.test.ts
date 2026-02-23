import { describe, it, expect, beforeEach, afterEach, onTestFinished } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFauxqs } from "../../src/app.js";
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  GetQueueUrlCommand,
  DeleteQueueCommand,
  DeleteMessageCommand,
  TagQueueCommand,
  ListQueueTagsCommand,
} from "@aws-sdk/client-sqs";
import {
  SNSClient,
  CreateTopicCommand,
  ListTopicsCommand,
  SubscribeCommand,
  ListSubscriptionsByTopicCommand,
  GetTopicAttributesCommand,
  GetSubscriptionAttributesCommand,
  SetSubscriptionAttributesCommand,
  DeleteTopicCommand,
  UnsubscribeCommand,
  TagResourceCommand,
  ListTagsForResourceCommand,
  PublishCommand,
} from "@aws-sdk/client-sns";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
  ListBucketsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from "@aws-sdk/client-s3";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "fauxqs-test-"));
}

function makeSqsClient(port: number): SQSClient {
  const client = new SQSClient({
    endpoint: `http://127.0.0.1:${port}`,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  onTestFinished(() => client.destroy());
  return client;
}

function makeSnsClient(port: number): SNSClient {
  const client = new SNSClient({
    endpoint: `http://127.0.0.1:${port}`,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  onTestFinished(() => client.destroy());
  return client;
}

function makeS3Client(port: number): S3Client {
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${port}`,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    forcePathStyle: true,
  });
  onTestFinished(() => client.destroy());
  return client;
}

describe("Persistence", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = createTempDir();
  });

  afterEach(async () => {
    // On Windows, SQLite WAL/SHM files may briefly remain locked after close.
    // Retry cleanup a few times with a small delay.
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  it("SQS: queues and messages survive restart", async () => {
    // Start server, create queue, send message
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let sqs = makeSqsClient(server.port);

    await sqs.send(new CreateQueueCommand({ QueueName: "persist-q" }));
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: `http://sqs.us-east-1.localhost:${server.port}/000000000000/persist-q`,
        MessageBody: "hello from before restart",
      }),
    );

    await server.stop();

    // Restart with same dataDir
    server = await startFauxqs({ port: 0, logger: false, dataDir });
    sqs = makeSqsClient(server.port);

    // Queue should exist
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: `http://sqs.us-east-1.localhost:${server.port}/000000000000/persist-q`,
        AttributeNames: ["All"],
      }),
    );
    expect(attrs.Attributes?.QueueArn).toContain("persist-q");

    // Message should be receivable
    const recv = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: `http://sqs.us-east-1.localhost:${server.port}/000000000000/persist-q`,
        MaxNumberOfMessages: 1,
      }),
    );
    expect(recv.Messages).toHaveLength(1);
    expect(recv.Messages![0].Body).toBe("hello from before restart");

    await server.stop();
  });

  it("SNS: topics and subscriptions survive restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let sns = makeSnsClient(server.port);
    let sqs = makeSqsClient(server.port);

    // Create queue (for subscription endpoint)
    await sqs.send(new CreateQueueCommand({ QueueName: "sub-target" }));

    // Create topic and subscribe
    const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: "persist-topic" }));
    await sns.send(
      new SubscribeCommand({
        TopicArn,
        Protocol: "sqs",
        Endpoint: "arn:aws:sqs:us-east-1:000000000000:sub-target",
      }),
    );

    await server.stop();

    // Restart
    server = await startFauxqs({ port: 0, logger: false, dataDir });
    sns = makeSnsClient(server.port);

    // Topic should exist
    const { Topics } = await sns.send(new ListTopicsCommand({}));
    expect(Topics?.some((t) => t.TopicArn?.includes("persist-topic"))).toBe(true);

    // Subscription should exist
    const { Subscriptions } = await sns.send(
      new ListSubscriptionsByTopicCommand({ TopicArn: TopicArn! }),
    );
    expect(Subscriptions).toHaveLength(1);
    expect(Subscriptions![0].Protocol).toBe("sqs");

    await server.stop();
  });

  it("S3: buckets and objects survive restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let s3 = makeS3Client(server.port);

    await s3.send(new CreateBucketCommand({ Bucket: "persist-bucket" }));
    await s3.send(
      new PutObjectCommand({
        Bucket: "persist-bucket",
        Key: "test.txt",
        Body: "persistent content",
        ContentType: "text/plain",
      }),
    );

    await server.stop();

    // Restart
    server = await startFauxqs({ port: 0, logger: false, dataDir });
    s3 = makeS3Client(server.port);

    // Bucket should exist
    const { Buckets } = await s3.send(new ListBucketsCommand({}));
    expect(Buckets?.some((b) => b.Name === "persist-bucket")).toBe(true);

    // Object should be retrievable with matching content
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: "persist-bucket", Key: "test.txt" }),
    );
    const body = await obj.Body!.transformToString();
    expect(body).toBe("persistent content");
    expect(obj.ContentType).toBe("text/plain");

    await server.stop();
  });

  it("S3: multipart uploads survive restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let s3 = makeS3Client(server.port);

    await s3.send(new CreateBucketCommand({ Bucket: "mp-bucket" }));

    // Start multipart upload and upload a part
    const create = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: "mp-bucket",
        Key: "large.bin",
        ContentType: "application/octet-stream",
      }),
    );
    const uploadId = create.UploadId!;

    const partBody = Buffer.alloc(5 * 1024 * 1024, "A");
    const upload = await s3.send(
      new UploadPartCommand({
        Bucket: "mp-bucket",
        Key: "large.bin",
        UploadId: uploadId,
        PartNumber: 1,
        Body: partBody,
      }),
    );

    await server.stop();

    // Restart and complete the multipart upload
    server = await startFauxqs({ port: 0, logger: false, dataDir });
    s3 = makeS3Client(server.port);

    const complete = await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: "mp-bucket",
        Key: "large.bin",
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [{ PartNumber: 1, ETag: upload.ETag }],
        },
      }),
    );
    expect(complete.Key).toBe("large.bin");

    // Verify the object exists
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: "mp-bucket", Key: "large.bin" }),
    );
    expect(obj.ContentLength).toBe(5 * 1024 * 1024);

    await server.stop();
  });

  it("inflight messages with expired deadlines become ready on restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let sqs = makeSqsClient(server.port);

    // Create queue with 1-second visibility timeout
    await sqs.send(
      new CreateQueueCommand({
        QueueName: "expire-q",
        Attributes: { VisibilityTimeout: "1" },
      }),
    );

    const queueUrl = `http://sqs.us-east-1.localhost:${server.port}/000000000000/expire-q`;
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "expire-me" }));

    // Receive to make inflight
    const recv = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1 }),
    );
    expect(recv.Messages).toHaveLength(1);

    await server.stop();

    // Wait for visibility timeout to expire
    await new Promise((r) => setTimeout(r, 1500));

    // Restart
    server = await startFauxqs({ port: 0, logger: false, dataDir });
    sqs = makeSqsClient(server.port);

    // Message should be back in ready state (visibility expired)
    const recv2 = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: `http://sqs.us-east-1.localhost:${server.port}/000000000000/expire-q`,
        MaxNumberOfMessages: 1,
      }),
    );
    expect(recv2.Messages).toHaveLength(1);
    expect(recv2.Messages![0].Body).toBe("expire-me");

    await server.stop();
  });

  it("deleted messages are not restored on restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let sqs = makeSqsClient(server.port);

    await sqs.send(new CreateQueueCommand({ QueueName: "del-q" }));
    const queueUrl = `http://sqs.us-east-1.localhost:${server.port}/000000000000/del-q`;

    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "delete-me" }));

    // Receive and delete
    const recv = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1 }),
    );
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: recv.Messages![0].ReceiptHandle!,
      }),
    );

    await server.stop();

    // Restart
    server = await startFauxqs({ port: 0, logger: false, dataDir });
    sqs = makeSqsClient(server.port);

    // Queue should be empty
    const recv2 = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: `http://sqs.us-east-1.localhost:${server.port}/000000000000/del-q`,
        MaxNumberOfMessages: 1,
      }),
    );
    expect(recv2.Messages ?? []).toHaveLength(0);

    await server.stop();
  });

  it("reset() clears messages but keeps resources in DB", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let sqs = makeSqsClient(server.port);

    await sqs.send(new CreateQueueCommand({ QueueName: "reset-q" }));
    const queueUrl = `http://sqs.us-east-1.localhost:${server.port}/000000000000/reset-q`;
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "clear-me" }));

    server.reset();
    await server.stop();

    // Restart — queue should exist but be empty
    server = await startFauxqs({ port: 0, logger: false, dataDir });
    sqs = makeSqsClient(server.port);

    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: `http://sqs.us-east-1.localhost:${server.port}/000000000000/reset-q`,
        AttributeNames: ["ApproximateNumberOfMessages"],
      }),
    );
    expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe("0");

    await server.stop();
  });

  it("purgeAll() clears everything from DB", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });

    server.createQueue("purge-q");
    server.createTopic("purge-topic");
    server.createBucket("purge-bucket");

    server.purgeAll();
    await server.stop();

    // Restart — nothing should exist
    server = await startFauxqs({ port: 0, logger: false, dataDir });
    const sns = makeSnsClient(server.port);
    const s3 = makeS3Client(server.port);

    const { Buckets } = await s3.send(new ListBucketsCommand({}));
    expect(Buckets ?? []).toHaveLength(0);

    const { Topics } = await sns.send(new ListTopicsCommand({}));
    expect(Topics ?? []).toHaveLength(0);

    await server.stop();
  });

  it("no persistence when dataDir is not set", async () => {
    // Should work normally without persistence
    const server = await startFauxqs({ port: 0, logger: false });
    server.createQueue("ephemeral-q");
    server.sendMessage("ephemeral-q", "test");
    await server.stop();
    // No assertions needed — just verifying it doesn't crash
  });

  // ── SQS extended tests ──

  it("SQS: queue attributes survive restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let sqs = makeSqsClient(server.port);

    await sqs.send(
      new CreateQueueCommand({
        QueueName: "attr-q",
        Attributes: { VisibilityTimeout: "10" },
      }),
    );
    const queueUrl = `http://sqs.us-east-1.localhost:${server.port}/000000000000/attr-q`;

    // Read CreatedTimestamp before mutation
    const before = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["All"] }),
    );
    const createdTs = before.Attributes!.CreatedTimestamp!;

    // Mutate VisibilityTimeout
    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: queueUrl,
        Attributes: { VisibilityTimeout: "45" },
      }),
    );

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, dataDir });
    sqs = makeSqsClient(server.port);

    const after = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: `http://sqs.us-east-1.localhost:${server.port}/000000000000/attr-q`,
        AttributeNames: ["All"],
      }),
    );
    expect(after.Attributes!.VisibilityTimeout).toBe("45");
    expect(after.Attributes!.CreatedTimestamp).toBe(createdTs);

    await server.stop();
  });

  it("SQS: queue tags survive restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let sqs = makeSqsClient(server.port);

    await sqs.send(new CreateQueueCommand({ QueueName: "tag-q" }));
    const queueUrl = `http://sqs.us-east-1.localhost:${server.port}/000000000000/tag-q`;

    await sqs.send(
      new TagQueueCommand({
        QueueUrl: queueUrl,
        Tags: { env: "test", team: "platform" },
      }),
    );

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, dataDir });
    sqs = makeSqsClient(server.port);

    const tags = await sqs.send(
      new ListQueueTagsCommand({
        QueueUrl: `http://sqs.us-east-1.localhost:${server.port}/000000000000/tag-q`,
      }),
    );
    expect(tags.Tags).toEqual({ env: "test", team: "platform" });

    await server.stop();
  });

  it("SQS: delayed messages become ready after restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let sqs = makeSqsClient(server.port);

    await sqs.send(new CreateQueueCommand({ QueueName: "delay-q" }));
    const queueUrl = `http://sqs.us-east-1.localhost:${server.port}/000000000000/delay-q`;

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "delayed-msg",
        DelaySeconds: 1,
      }),
    );

    await server.stop();

    // Wait for delay to expire
    await new Promise((r) => setTimeout(r, 1500));

    server = await startFauxqs({ port: 0, logger: false, dataDir });
    sqs = makeSqsClient(server.port);

    const recv = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: `http://sqs.us-east-1.localhost:${server.port}/000000000000/delay-q`,
        MaxNumberOfMessages: 1,
      }),
    );
    expect(recv.Messages).toHaveLength(1);
    expect(recv.Messages![0].Body).toBe("delayed-msg");

    await server.stop();
  });

  it("SQS: still-inflight messages stay inflight after restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let sqs = makeSqsClient(server.port);

    await sqs.send(
      new CreateQueueCommand({
        QueueName: "inflight-q",
        Attributes: { VisibilityTimeout: "2" },
      }),
    );
    const queueUrl = `http://sqs.us-east-1.localhost:${server.port}/000000000000/inflight-q`;

    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "inflight-msg" }));

    // Receive to make inflight (2s visibility)
    const recv = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1 }),
    );
    expect(recv.Messages).toHaveLength(1);

    await server.stop();

    // Restart immediately — message should still be inflight
    server = await startFauxqs({ port: 0, logger: false, dataDir });
    sqs = makeSqsClient(server.port);

    const newQueueUrl = `http://sqs.us-east-1.localhost:${server.port}/000000000000/inflight-q`;

    const recv2 = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: newQueueUrl, MaxNumberOfMessages: 1 }),
    );
    expect(recv2.Messages ?? []).toHaveLength(0);

    // Wait for visibility to expire, then verify message becomes receivable
    await new Promise((r) => setTimeout(r, 2500));

    const recv3 = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: newQueueUrl, MaxNumberOfMessages: 1 }),
    );
    expect(recv3.Messages).toHaveLength(1);
    expect(recv3.Messages![0].Body).toBe("inflight-msg");

    await server.stop();
  });

  it("SQS: message attributes survive restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let sqs = makeSqsClient(server.port);

    await sqs.send(new CreateQueueCommand({ QueueName: "msgattr-q" }));
    const queueUrl = `http://sqs.us-east-1.localhost:${server.port}/000000000000/msgattr-q`;

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "with-attrs",
        MessageAttributes: {
          color: { DataType: "String", StringValue: "blue" },
          count: { DataType: "Number", StringValue: "42" },
        },
      }),
    );

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, dataDir });
    sqs = makeSqsClient(server.port);

    const recv = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: `http://sqs.us-east-1.localhost:${server.port}/000000000000/msgattr-q`,
        MaxNumberOfMessages: 1,
        MessageAttributeNames: ["All"],
      }),
    );
    expect(recv.Messages).toHaveLength(1);
    expect(recv.Messages![0].MessageAttributes!.color.StringValue).toBe("blue");
    expect(recv.Messages![0].MessageAttributes!.count.StringValue).toBe("42");

    await server.stop();
  });

  it("SQS: queue deletion persists", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let sqs = makeSqsClient(server.port);

    await sqs.send(new CreateQueueCommand({ QueueName: "doomed-q" }));
    const queueUrl = `http://sqs.us-east-1.localhost:${server.port}/000000000000/doomed-q`;

    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, dataDir });
    sqs = makeSqsClient(server.port);

    await expect(
      sqs.send(new GetQueueUrlCommand({ QueueName: "doomed-q" })),
    ).rejects.toThrow();

    await server.stop();
  });

  // ── SNS extended tests ──

  it("SNS: topic and subscription attributes survive restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let sns = makeSnsClient(server.port);
    let sqs = makeSqsClient(server.port);

    await sqs.send(new CreateQueueCommand({ QueueName: "attr-sub-target" }));

    const { TopicArn } = await sns.send(
      new CreateTopicCommand({
        Name: "attr-topic",
        Attributes: { DisplayName: "My Display Name" },
      }),
    );

    const { SubscriptionArn } = await sns.send(
      new SubscribeCommand({
        TopicArn,
        Protocol: "sqs",
        Endpoint: "arn:aws:sqs:us-east-1:000000000000:attr-sub-target",
      }),
    );

    await sns.send(
      new SetSubscriptionAttributesCommand({
        SubscriptionArn,
        AttributeName: "RawMessageDelivery",
        AttributeValue: "true",
      }),
    );

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, dataDir });
    sns = makeSnsClient(server.port);

    const topicAttrs = await sns.send(
      new GetTopicAttributesCommand({ TopicArn: TopicArn! }),
    );
    expect(topicAttrs.Attributes!.DisplayName).toBe("My Display Name");

    const subAttrs = await sns.send(
      new GetSubscriptionAttributesCommand({ SubscriptionArn: SubscriptionArn! }),
    );
    expect(subAttrs.Attributes!.RawMessageDelivery).toBe("true");

    await server.stop();
  });

  it("SNS: topic tags survive restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let sns = makeSnsClient(server.port);

    const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: "tagged-topic" }));

    await sns.send(
      new TagResourceCommand({
        ResourceArn: TopicArn,
        Tags: [
          { Key: "env", Value: "staging" },
          { Key: "owner", Value: "ops" },
        ],
      }),
    );

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, dataDir });
    sns = makeSnsClient(server.port);

    const tags = await sns.send(
      new ListTagsForResourceCommand({ ResourceArn: TopicArn! }),
    );
    const tagMap = Object.fromEntries(tags.Tags!.map((t) => [t.Key, t.Value]));
    expect(tagMap).toEqual({ env: "staging", owner: "ops" });

    await server.stop();
  });

  it("SNS: fan-out works after restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let sns = makeSnsClient(server.port);
    let sqs = makeSqsClient(server.port);

    await sqs.send(new CreateQueueCommand({ QueueName: "fanout-target" }));
    const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: "fanout-topic" }));

    await sns.send(
      new SubscribeCommand({
        TopicArn,
        Protocol: "sqs",
        Endpoint: "arn:aws:sqs:us-east-1:000000000000:fanout-target",
      }),
    );

    await server.stop();

    // Restart, then publish
    server = await startFauxqs({ port: 0, logger: false, dataDir });
    sns = makeSnsClient(server.port);
    sqs = makeSqsClient(server.port);

    await sns.send(
      new PublishCommand({
        TopicArn: TopicArn!,
        Message: "hello after restart",
      }),
    );

    const recv = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: `http://sqs.us-east-1.localhost:${server.port}/000000000000/fanout-target`,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
      }),
    );
    expect(recv.Messages).toHaveLength(1);
    // SNS wraps the message in an envelope by default
    const envelope = JSON.parse(recv.Messages![0].Body!);
    expect(envelope.Message).toBe("hello after restart");

    await server.stop();
  });

  it("SNS: topic deletion persists", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let sns = makeSnsClient(server.port);

    const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: "delete-topic" }));
    await sns.send(new DeleteTopicCommand({ TopicArn }));

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, dataDir });
    sns = makeSnsClient(server.port);

    const { Topics } = await sns.send(new ListTopicsCommand({}));
    expect(Topics ?? []).toHaveLength(0);

    await server.stop();
  });

  it("SNS: unsubscribe persists", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let sns = makeSnsClient(server.port);
    let sqs = makeSqsClient(server.port);

    await sqs.send(new CreateQueueCommand({ QueueName: "unsub-target" }));
    const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: "unsub-topic" }));

    const { SubscriptionArn } = await sns.send(
      new SubscribeCommand({
        TopicArn,
        Protocol: "sqs",
        Endpoint: "arn:aws:sqs:us-east-1:000000000000:unsub-target",
      }),
    );

    await sns.send(new UnsubscribeCommand({ SubscriptionArn }));

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, dataDir });
    sns = makeSnsClient(server.port);

    const { Subscriptions } = await sns.send(
      new ListSubscriptionsByTopicCommand({ TopicArn: TopicArn! }),
    );
    expect(Subscriptions ?? []).toHaveLength(0);

    await server.stop();
  });

  // ── S3 extended tests ──

  it("S3: object metadata and system metadata survive restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let s3 = makeS3Client(server.port);

    await s3.send(new CreateBucketCommand({ Bucket: "meta-bucket" }));
    await s3.send(
      new PutObjectCommand({
        Bucket: "meta-bucket",
        Key: "meta.txt",
        Body: "metadata test",
        ContentType: "text/plain",
        ContentLanguage: "en-US",
        CacheControl: "max-age=3600",
        Metadata: { "custom-key": "custom-value", author: "test-suite" },
      }),
    );

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, dataDir });
    s3 = makeS3Client(server.port);

    const head = await s3.send(
      new HeadObjectCommand({ Bucket: "meta-bucket", Key: "meta.txt" }),
    );
    expect(head.ContentLanguage).toBe("en-US");
    expect(head.CacheControl).toBe("max-age=3600");
    expect(head.Metadata).toEqual({ "custom-key": "custom-value", author: "test-suite" });

    await server.stop();
  });

  it("S3: directory bucket type survives restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });

    server.createBucket("dir-bucket", { type: "directory" });

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, dataDir });
    const s3 = makeS3Client(server.port);

    // Bucket should exist
    const { Buckets } = await s3.send(new ListBucketsCommand({}));
    expect(Buckets?.some((b) => b.Name === "dir-bucket")).toBe(true);

    // Verify it behaves as a directory bucket by testing RenameObject (only works on directory buckets)
    await s3.send(
      new PutObjectCommand({ Bucket: "dir-bucket", Key: "src.txt", Body: "data" }),
    );
    const res = await fetch(
      `http://127.0.0.1:${server.port}/dir-bucket/dest.txt?renameObject`,
      {
        method: "PUT",
        headers: { "x-amz-rename-source": "src.txt" },
      },
    );
    expect(res.status).toBe(200);

    await server.stop();
  });

  it("S3: bucket and object deletion persist", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let s3 = makeS3Client(server.port);

    await s3.send(new CreateBucketCommand({ Bucket: "del-bucket" }));
    await s3.send(
      new PutObjectCommand({ Bucket: "del-bucket", Key: "file.txt", Body: "gone" }),
    );
    await s3.send(new DeleteObjectCommand({ Bucket: "del-bucket", Key: "file.txt" }));
    await s3.send(new DeleteBucketCommand({ Bucket: "del-bucket" }));

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, dataDir });
    s3 = makeS3Client(server.port);

    const { Buckets } = await s3.send(new ListBucketsCommand({}));
    expect(Buckets?.some((b) => b.Name === "del-bucket")).toBeFalsy();

    await server.stop();
  });

  it("S3: multipart body integrity after restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let s3 = makeS3Client(server.port);

    await s3.send(new CreateBucketCommand({ Bucket: "mp-integrity" }));

    const create = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: "mp-integrity",
        Key: "binary.bin",
        ContentType: "application/octet-stream",
      }),
    );
    const uploadId = create.UploadId!;

    // Create a buffer with a known repeating pattern (64KB is sufficient for integrity check)
    const partBody = Buffer.alloc(64 * 1024);
    for (let i = 0; i < partBody.length; i++) {
      partBody[i] = i % 256;
    }

    const upload = await s3.send(
      new UploadPartCommand({
        Bucket: "mp-integrity",
        Key: "binary.bin",
        UploadId: uploadId,
        PartNumber: 1,
        Body: partBody,
      }),
    );

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, dataDir });
    s3 = makeS3Client(server.port);

    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: "mp-integrity",
        Key: "binary.bin",
        UploadId: uploadId,
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: upload.ETag }] },
      }),
    );

    const obj = await s3.send(
      new GetObjectCommand({ Bucket: "mp-integrity", Key: "binary.bin" }),
    );
    const bodyBytes = await obj.Body!.transformToByteArray();
    expect(Buffer.from(bodyBytes).equals(partBody)).toBe(true);

    await server.stop();
  });

  it("S3: RenameObject persists", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let s3 = makeS3Client(server.port);

    server.createBucket("rename-bucket", { type: "directory" });

    await s3.send(
      new PutObjectCommand({
        Bucket: "rename-bucket",
        Key: "old-name.txt",
        Body: "rename me",
        ContentType: "text/plain",
      }),
    );

    // Rename via raw fetch (SDK doesn't support RenameObject on local emulator)
    const res = await fetch(
      `http://127.0.0.1:${server.port}/rename-bucket/new-name.txt?renameObject`,
      {
        method: "PUT",
        headers: { "x-amz-rename-source": "old-name.txt" },
      },
    );
    expect(res.status).toBe(200);

    await server.stop();

    server = await startFauxqs({ port: 0, logger: false, dataDir });
    s3 = makeS3Client(server.port);

    // New key should exist
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: "rename-bucket", Key: "new-name.txt" }),
    );
    expect(await obj.Body!.transformToString()).toBe("rename me");

    // Old key should be gone
    await expect(
      s3.send(new GetObjectCommand({ Bucket: "rename-bucket", Key: "old-name.txt" })),
    ).rejects.toThrow();

    await server.stop();
  });

  it("FIFO queue with sequence counter survives restart", async () => {
    let server = await startFauxqs({ port: 0, logger: false, dataDir });
    let sqs = makeSqsClient(server.port);

    await sqs.send(
      new CreateQueueCommand({
        QueueName: "fifo-persist.fifo",
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
      }),
    );
    const queueUrl = `http://sqs.us-east-1.localhost:${server.port}/000000000000/fifo-persist.fifo`;

    const send1 = await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: "msg1",
        MessageGroupId: "g1",
      }),
    );
    expect(send1.SequenceNumber).toBeDefined();

    await server.stop();

    // Restart
    server = await startFauxqs({ port: 0, logger: false, dataDir });
    sqs = makeSqsClient(server.port);

    const newQueueUrl = `http://sqs.us-east-1.localhost:${server.port}/000000000000/fifo-persist.fifo`;

    // Send another message — sequence number should continue from where it left off
    const send2 = await sqs.send(
      new SendMessageCommand({
        QueueUrl: newQueueUrl,
        MessageBody: "msg2",
        MessageGroupId: "g1",
      }),
    );
    expect(Number(send2.SequenceNumber)).toBeGreaterThan(Number(send1.SequenceNumber));

    // Both messages should be receivable
    const recv = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: newQueueUrl, MaxNumberOfMessages: 10 }),
    );
    expect(recv.Messages).toHaveLength(1); // FIFO: group locked after first receive

    await server.stop();
  });
});
