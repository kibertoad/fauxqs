import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  PutBucketNotificationConfigurationCommand,
  GetBucketNotificationConfigurationCommand,
} from "@aws-sdk/client-s3";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { CreateTopicCommand, SubscribeCommand } from "@aws-sdk/client-sns";
import { createS3Client, createSqsClient, createSnsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("S3 Event Notifications", () => {
  let server: FauxqsServer;
  let s3: ReturnType<typeof createS3Client>;
  let sqs: ReturnType<typeof createSqsClient>;
  let sns: ReturnType<typeof createSnsClient>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    s3 = createS3Client(server.port);
    sqs = createSqsClient(server.port);
    sns = createSnsClient(server.port);
  });

  afterAll(async () => {
    s3.destroy();
    sqs.destroy();
    sns.destroy();
    await server.stop();
  });

  async function makeQueue(name: string): Promise<{ url: string; arn: string }> {
    const created = await sqs.send(new CreateQueueCommand({ QueueName: name }));
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: created.QueueUrl!, AttributeNames: ["QueueArn"] }),
    );
    return { url: created.QueueUrl!, arn: attrs.Attributes!.QueueArn! };
  }

  async function receiveOne(queueUrl: string): Promise<Record<string, unknown>[]> {
    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    return (result.Messages ?? []).map((m) => JSON.parse(m.Body!));
  }

  it("delivers an ObjectCreated event to an SQS queue", async () => {
    const bucket = "notif-basic";
    const queue = await makeQueue("notif-basic-queue");
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucket,
        NotificationConfiguration: {
          QueueConfigurations: [
            { Id: "all", QueueArn: queue.arn, Events: ["s3:ObjectCreated:*"] },
          ],
        },
      }),
    );

    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "report.txt", Body: "hello" }));

    const events = await receiveOne(queue.url);
    expect(events).toHaveLength(1);
    const record = (events[0].Records as Record<string, any>[])[0];
    expect(record.eventSource).toBe("aws:s3");
    expect(record.eventName).toBe("ObjectCreated:Put");
    expect(record.s3.bucket.name).toBe(bucket);
    expect(record.s3.object.key).toBe("report.txt");
    expect(record.s3.object.size).toBe(5);
  });

  it("URL-encodes the object key in the event record", async () => {
    const bucket = "notif-encoded-key";
    const queue = await makeQueue("notif-encoded-key-queue");
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucket,
        NotificationConfiguration: {
          QueueConfigurations: [{ QueueArn: queue.arn, Events: ["s3:ObjectCreated:*"] }],
        },
      }),
    );

    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "my folder/a b.txt", Body: "x" }));

    const events = await receiveOne(queue.url);
    expect(events).toHaveLength(1);
    const record = (events[0].Records as Record<string, any>[])[0];
    // Spaces become "+"; path separators stay literal — as real S3 delivers it.
    expect(record.s3.object.key).toBe("my+folder/a+b.txt");
  });

  it("applies prefix and suffix filters", async () => {
    const bucket = "notif-filter";
    const queue = await makeQueue("notif-filter-queue");
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucket,
        NotificationConfiguration: {
          QueueConfigurations: [
            {
              QueueArn: queue.arn,
              Events: ["s3:ObjectCreated:*"],
              Filter: {
                Key: {
                  FilterRules: [
                    { Name: "prefix", Value: "images/" },
                    { Name: "suffix", Value: ".png" },
                  ],
                },
              },
            },
          ],
        },
      }),
    );

    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "images/logo.png", Body: "a" }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "images/logo.jpg", Body: "b" }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "docs/readme.png", Body: "c" }));

    const events = await receiveOne(queue.url);
    expect(events).toHaveLength(1);
    expect((events[0].Records as Record<string, any>[])[0].s3.object.key).toBe("images/logo.png");
  });

  it("delivers only the configured event types", async () => {
    const bucket = "notif-event-type";
    const queue = await makeQueue("notif-event-type-queue");
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucket,
        NotificationConfiguration: {
          QueueConfigurations: [
            { QueueArn: queue.arn, Events: ["s3:ObjectCreated:Put"] },
          ],
        },
      }),
    );

    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "src.txt", Body: "data" }));
    // A copy raises ObjectCreated:Copy, which is not subscribed.
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: "dst.txt",
        CopySource: `${bucket}/src.txt`,
      }),
    );

    const events = await receiveOne(queue.url);
    expect(events).toHaveLength(1);
    expect((events[0].Records as Record<string, any>[])[0].eventName).toBe("ObjectCreated:Put");
  });

  it("delivers an ObjectRemoved event on delete", async () => {
    const bucket = "notif-delete";
    const queue = await makeQueue("notif-delete-queue");
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucket,
        NotificationConfiguration: {
          QueueConfigurations: [
            { QueueArn: queue.arn, Events: ["s3:ObjectRemoved:*"] },
          ],
        },
      }),
    );

    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "temp.txt", Body: "x" }));
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: "temp.txt" }));

    const events = await receiveOne(queue.url);
    // The Put is not subscribed; only the Delete is delivered.
    expect(events).toHaveLength(1);
    expect((events[0].Records as Record<string, any>[])[0].eventName).toBe("ObjectRemoved:Delete");
  });

  it("delivers CompleteMultipartUpload events", async () => {
    const bucket = "notif-mpu";
    const queue = await makeQueue("notif-mpu-queue");
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucket,
        NotificationConfiguration: {
          QueueConfigurations: [
            { QueueArn: queue.arn, Events: ["s3:ObjectCreated:*"] },
          ],
        },
      }),
    );

    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: "big.bin" }),
    );
    const part = await s3.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: "big.bin",
        UploadId,
        PartNumber: 1,
        Body: "multipart payload",
      }),
    );
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: "big.bin",
        UploadId,
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag }] },
      }),
    );

    const events = await receiveOne(queue.url);
    expect(events).toHaveLength(1);
    expect((events[0].Records as Record<string, any>[])[0].eventName).toBe(
      "ObjectCreated:CompleteMultipartUpload",
    );
  });

  it("delivers to an SNS topic that fans out to a subscribed SQS queue", async () => {
    const bucket = "notif-sns";
    const queue = await makeQueue("notif-sns-queue");
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    const topic = await sns.send(new CreateTopicCommand({ Name: "notif-sns-topic" }));
    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: queue.arn,
      }),
    );

    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucket,
        NotificationConfiguration: {
          TopicConfigurations: [
            { TopicArn: topic.TopicArn!, Events: ["s3:ObjectCreated:*"] },
          ],
        },
      }),
    );

    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "via-sns.txt", Body: "y" }));

    const envelopes = await receiveOne(queue.url);
    expect(envelopes).toHaveLength(1);
    // The SQS message is the SNS notification envelope; the S3 event is in Message.
    expect(envelopes[0].Type).toBe("Notification");
    const records = JSON.parse(envelopes[0].Message as string).Records;
    expect(records[0].eventName).toBe("ObjectCreated:Put");
    expect(records[0].s3.object.key).toBe("via-sns.txt");
  });

  it("round-trips the notification configuration via GET", async () => {
    const bucket = "notif-roundtrip";
    const queue = await makeQueue("notif-roundtrip-queue");
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucket,
        NotificationConfiguration: {
          QueueConfigurations: [
            {
              Id: "cfg-1",
              QueueArn: queue.arn,
              Events: ["s3:ObjectCreated:*", "s3:ObjectRemoved:*"],
              Filter: { Key: { FilterRules: [{ Name: "prefix", Value: "uploads/" }] } },
            },
          ],
        },
      }),
    );

    const config = await s3.send(
      new GetBucketNotificationConfigurationCommand({ Bucket: bucket }),
    );
    expect(config.QueueConfigurations).toHaveLength(1);
    const qc = config.QueueConfigurations![0];
    expect(qc.Id).toBe("cfg-1");
    expect(qc.QueueArn).toBe(queue.arn);
    expect(qc.Events).toEqual(
      expect.arrayContaining(["s3:ObjectCreated:*", "s3:ObjectRemoved:*"]),
    );
    expect(qc.Filter!.Key!.FilterRules![0]).toMatchObject({ Name: "prefix", Value: "uploads/" });
  });

  it("returns an empty configuration when none is set", async () => {
    const bucket = "notif-empty";
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    const config = await s3.send(
      new GetBucketNotificationConfigurationCommand({ Bucket: bucket }),
    );
    expect(config.QueueConfigurations ?? []).toHaveLength(0);
    expect(config.TopicConfigurations ?? []).toHaveLength(0);
  });

  it("rejects a configuration whose destination queue does not exist", async () => {
    const bucket = "notif-bad-dest";
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    await expect(
      s3.send(
        new PutBucketNotificationConfigurationCommand({
          Bucket: bucket,
          NotificationConfiguration: {
            QueueConfigurations: [
              {
                QueueArn: "arn:aws:sqs:us-east-1:000000000000:notif-no-such-queue",
                Events: ["s3:ObjectCreated:*"],
              },
            ],
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects a configuration with an unsupported event name", async () => {
    const bucket = "notif-bad-event";
    const queue = await makeQueue("notif-bad-event-queue");
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    await expect(
      s3.send(
        new PutBucketNotificationConfigurationCommand({
          Bucket: bucket,
          NotificationConfiguration: {
            QueueConfigurations: [
              {
                QueueArn: queue.arn,
                // Misspelled category ("ObjectCreate") — real S3 rejects this.
                Events: ["s3:ObjectCreate:*" as unknown as "s3:ObjectCreated:*"],
              },
            ],
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("delivers to a FIFO SNS topic that fans out to a FIFO SQS queue", async () => {
    const bucket = "notif-fifo";
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    const fifoQueue = await sqs.send(
      new CreateQueueCommand({
        QueueName: "notif-fifo-queue.fifo",
        Attributes: { FifoQueue: "true" },
      }),
    );
    const fifoQueueArn = (
      await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: fifoQueue.QueueUrl!,
          AttributeNames: ["QueueArn"],
        }),
      )
    ).Attributes!.QueueArn!;

    const topic = await sns.send(
      new CreateTopicCommand({
        Name: "notif-fifo-topic.fifo",
        Attributes: { FifoTopic: "true" },
      }),
    );
    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: fifoQueueArn,
      }),
    );

    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucket,
        NotificationConfiguration: {
          TopicConfigurations: [{ TopicArn: topic.TopicArn!, Events: ["s3:ObjectCreated:*"] }],
        },
      }),
    );

    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: "fifo-evt.txt", Body: "z" }));

    const result = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: fifoQueue.QueueUrl!,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ["All"],
      }),
    );
    expect(result.Messages).toHaveLength(1);
    const message = result.Messages![0];
    // FIFO delivery needs a group id and an assigned sequence number.
    expect(message.Attributes?.MessageGroupId).toBe(bucket);
    expect(message.Attributes?.SequenceNumber).toBeDefined();
    const records = JSON.parse(JSON.parse(message.Body!).Message).Records;
    expect(records[0].eventName).toBe("ObjectCreated:Put");
  });
});
