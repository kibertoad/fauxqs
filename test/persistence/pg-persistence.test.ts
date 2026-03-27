import { describe, it, expect, beforeAll, afterAll, onTestFinished } from "vitest";
import { startFauxqs } from "../../src/app.js";
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  GetQueueUrlCommand,
} from "@aws-sdk/client-sqs";
import {
  SNSClient,
  CreateTopicCommand,
  ListTopicsCommand,
  SubscribeCommand,
  ListSubscriptionsByTopicCommand,
} from "@aws-sdk/client-sns";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListBucketsCommand,
} from "@aws-sdk/client-s3";

const PG_URL = process.env.FAUXQS_TEST_PG_URL;

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

describe.skipIf(!PG_URL)("PostgreSQL Persistence", () => {
  // Clean PG tables before test suite
  beforeAll(async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_URL });
    await pool.query("DROP TABLE IF EXISTS s3_multipart_parts CASCADE");
    await pool.query("DROP TABLE IF EXISTS s3_multipart_uploads CASCADE");
    await pool.query("DROP TABLE IF EXISTS s3_objects CASCADE");
    await pool.query("DROP TABLE IF EXISTS s3_bucket_lifecycle_configurations CASCADE");
    await pool.query("DROP TABLE IF EXISTS s3_buckets CASCADE");
    await pool.query("DROP TABLE IF EXISTS sns_subscriptions CASCADE");
    await pool.query("DROP TABLE IF EXISTS sns_topics CASCADE");
    await pool.query("DROP TABLE IF EXISTS sqs_messages CASCADE");
    await pool.query("DROP TABLE IF EXISTS sqs_queues CASCADE");
    await pool.end();
  });

  it("SQS messages survive restart", async () => {
    // Start server with PG persistence
    const server1 = await startFauxqs({
      port: 0,
      logger: false,
      persistenceBackend: "postgresql",
      postgresqlUrl: PG_URL!,
    });

    const sqs = makeSqsClient(server1.port);
    await sqs.send(new CreateQueueCommand({ QueueName: "pg-test-queue" }));
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: "pg-test-queue" }));
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: "pg-test-message" }));
    await server1.stop();

    // Restart with same PG
    const server2 = await startFauxqs({
      port: 0,
      logger: false,
      persistenceBackend: "postgresql",
      postgresqlUrl: PG_URL!,
    });

    const sqs2 = makeSqsClient(server2.port);
    const { QueueUrl: QueueUrl2 } = await sqs2.send(
      new GetQueueUrlCommand({ QueueName: "pg-test-queue" }),
    );
    const { Messages } = await sqs2.send(
      new ReceiveMessageCommand({ QueueUrl: QueueUrl2, WaitTimeSeconds: 1, MaxNumberOfMessages: 1 }),
    );
    expect(Messages).toHaveLength(1);
    expect(Messages![0].Body).toBe("pg-test-message");
    await server2.stop();
  });

  it("SNS topics and subscriptions survive restart", async () => {
    const server1 = await startFauxqs({
      port: 0,
      logger: false,
      persistenceBackend: "postgresql",
      postgresqlUrl: PG_URL!,
    });

    const sns = makeSnsClient(server1.port);
    const sqs = makeSqsClient(server1.port);

    await sqs.send(new CreateQueueCommand({ QueueName: "pg-sns-queue" }));
    const { TopicArn } = (
      await sns.send(new CreateTopicCommand({ Name: "pg-sns-topic" }))
    );
    await sns.send(
      new SubscribeCommand({
        TopicArn,
        Protocol: "sqs",
        Endpoint: `arn:aws:sqs:us-east-1:000000000000:pg-sns-queue`,
      }),
    );
    await server1.stop();

    // Restart
    const server2 = await startFauxqs({
      port: 0,
      logger: false,
      persistenceBackend: "postgresql",
      postgresqlUrl: PG_URL!,
    });

    const sns2 = makeSnsClient(server2.port);
    const { Topics } = await sns2.send(new ListTopicsCommand({}));
    const topicArns = (Topics ?? []).map((t) => t.TopicArn!);
    expect(topicArns).toContain(TopicArn);

    const { Subscriptions } = await sns2.send(
      new ListSubscriptionsByTopicCommand({ TopicArn }),
    );
    expect(Subscriptions).toHaveLength(1);
    await server2.stop();
  });

  it("S3 objects survive restart", async () => {
    const server1 = await startFauxqs({
      port: 0,
      logger: false,
      persistenceBackend: "postgresql",
      postgresqlUrl: PG_URL!,
    });

    const s3 = makeS3Client(server1.port);
    await s3.send(new CreateBucketCommand({ Bucket: "pg-test-bucket" }));
    await s3.send(
      new PutObjectCommand({
        Bucket: "pg-test-bucket",
        Key: "test.txt",
        Body: "pg-test-content",
        ContentType: "text/plain",
      }),
    );
    await server1.stop();

    // Restart
    const server2 = await startFauxqs({
      port: 0,
      logger: false,
      persistenceBackend: "postgresql",
      postgresqlUrl: PG_URL!,
    });

    const s3b = makeS3Client(server2.port);
    const { Buckets } = await s3b.send(new ListBucketsCommand({}));
    expect(Buckets!.map((b) => b.Name)).toContain("pg-test-bucket");

    const obj = await s3b.send(
      new GetObjectCommand({ Bucket: "pg-test-bucket", Key: "test.txt" }),
    );
    const body = await obj.Body!.transformToString();
    expect(body).toBe("pg-test-content");
    await server2.stop();
  });

  afterAll(async () => {
    // Clean up PG tables
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_URL });
    await pool.query("DROP TABLE IF EXISTS s3_multipart_parts CASCADE");
    await pool.query("DROP TABLE IF EXISTS s3_multipart_uploads CASCADE");
    await pool.query("DROP TABLE IF EXISTS s3_objects CASCADE");
    await pool.query("DROP TABLE IF EXISTS s3_bucket_lifecycle_configurations CASCADE");
    await pool.query("DROP TABLE IF EXISTS s3_buckets CASCADE");
    await pool.query("DROP TABLE IF EXISTS sns_subscriptions CASCADE");
    await pool.query("DROP TABLE IF EXISTS sns_topics CASCADE");
    await pool.query("DROP TABLE IF EXISTS sqs_messages CASCADE");
    await pool.query("DROP TABLE IF EXISTS sqs_queues CASCADE");
    await pool.end();
  });
});
