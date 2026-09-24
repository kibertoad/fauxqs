import { describe, it, expect, beforeAll, afterAll, onTestFinished } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { startFauxqs } from "../../src/app.js";
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  StartMessageMoveTaskCommand,
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
  PutBucketNotificationConfigurationCommand,
  GetBucketNotificationConfigurationCommand,
} from "@aws-sdk/client-s3";

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

describe("PostgreSQL Persistence", () => {
  let pgContainer: StartedPostgreSqlContainer;
  let pgUrl: string;

  beforeAll(async () => {
    pgContainer = await new PostgreSqlContainer("postgres:17-alpine").start();
    pgUrl = pgContainer.getConnectionUri();
  }, 60_000);

  afterAll(async () => {
    await pgContainer?.stop();
  });

  it("SQS messages survive restart", async () => {
    const server1 = await startFauxqs({
      port: 0,
      logger: false,
      persistenceBackend: "postgresql",
      postgresqlUrl: pgUrl,
    });

    const sqs = makeSqsClient(server1.port);
    await sqs.send(new CreateQueueCommand({ QueueName: "pg-test-queue" }));
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: "pg-test-queue" }));
    await sqs.send(new SendMessageCommand({ QueueUrl, MessageBody: "pg-test-message" }));
    await server1.stop();

    const server2 = await startFauxqs({
      port: 0,
      logger: false,
      persistenceBackend: "postgresql",
      postgresqlUrl: pgUrl,
    });

    const sqs2 = makeSqsClient(server2.port);
    const { QueueUrl: QueueUrl2 } = await sqs2.send(
      new GetQueueUrlCommand({ QueueName: "pg-test-queue" }),
    );
    const { Messages } = await sqs2.send(
      new ReceiveMessageCommand({
        QueueUrl: QueueUrl2,
        WaitTimeSeconds: 1,
        MaxNumberOfMessages: 1,
      }),
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
      postgresqlUrl: pgUrl,
    });

    const sns = makeSnsClient(server1.port);
    const sqs = makeSqsClient(server1.port);

    await sqs.send(new CreateQueueCommand({ QueueName: "pg-sns-queue" }));
    const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: "pg-sns-topic" }));
    await sns.send(
      new SubscribeCommand({
        TopicArn,
        Protocol: "sqs",
        Endpoint: "arn:aws:sqs:us-east-1:000000000000:pg-sns-queue",
      }),
    );
    await server1.stop();

    const server2 = await startFauxqs({
      port: 0,
      logger: false,
      persistenceBackend: "postgresql",
      postgresqlUrl: pgUrl,
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
      postgresqlUrl: pgUrl,
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

    const server2 = await startFauxqs({
      port: 0,
      logger: false,
      persistenceBackend: "postgresql",
      postgresqlUrl: pgUrl,
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

  it("dead-letter origin survives restart so redrive returns messages home", async () => {
    const start = () =>
      startFauxqs({ port: 0, logger: false, persistenceBackend: "postgresql", postgresqlUrl: pgUrl });
    let server = await start();
    let sqs = makeSqsClient(server.port);
    const url = (name: string) =>
      `http://sqs.us-east-1.localhost:${server.port}/000000000000/${name}`;

    await sqs.send(new CreateQueueCommand({ QueueName: "pg-redrive-dlq" }));
    await sqs.send(new CreateQueueCommand({ QueueName: "pg-redrive-src-a" }));
    await sqs.send(new CreateQueueCommand({ QueueName: "pg-redrive-src-b" }));
    const dlqArn = (
      await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: url("pg-redrive-dlq"),
          AttributeNames: ["QueueArn"],
        }),
      )
    ).Attributes!.QueueArn!;

    // Two sources share the DLQ, so only the persisted origin ARN can route the message home.
    for (const name of ["pg-redrive-src-a", "pg-redrive-src-b"]) {
      await sqs.send(
        new SetQueueAttributesCommand({
          QueueUrl: url(name),
          Attributes: {
            RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 1 }),
          },
        }),
      );
    }
    await sqs.send(
      new SendMessageCommand({ QueueUrl: url("pg-redrive-src-a"), MessageBody: "home" }),
    );
    for (let i = 0; i < 2; i++) {
      await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: url("pg-redrive-src-a"), VisibilityTimeout: 0 }),
      );
    }
    await server.stop();

    server = await start();
    sqs = makeSqsClient(server.port);
    await sqs.send(new StartMessageMoveTaskCommand({ SourceArn: dlqArn }));

    const backHome = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: url("pg-redrive-src-a"), WaitTimeSeconds: 1 }),
    );
    expect(backHome.Messages).toHaveLength(1);
    expect(backHome.Messages![0].Body).toBe("home");
    await server.stop();
  });

  it("bucket notification configuration survives restart", async () => {
    const start = () =>
      startFauxqs({ port: 0, logger: false, persistenceBackend: "postgresql", postgresqlUrl: pgUrl });
    let server = await start();
    let sqs = makeSqsClient(server.port);
    let s3 = makeS3Client(server.port);
    const queueUrl = () =>
      `http://sqs.us-east-1.localhost:${server.port}/000000000000/pg-notif-queue`;

    await sqs.send(new CreateQueueCommand({ QueueName: "pg-notif-queue" }));
    const queueArn = (
      await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: queueUrl(), AttributeNames: ["QueueArn"] }),
      )
    ).Attributes!.QueueArn!;
    await s3.send(new CreateBucketCommand({ Bucket: "pg-notif-bucket" }));
    await s3.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: "pg-notif-bucket",
        NotificationConfiguration: {
          QueueConfigurations: [
            { Id: "pg-cfg", QueueArn: queueArn, Events: ["s3:ObjectCreated:*"] },
          ],
        },
      }),
    );
    await server.stop();

    server = await start();
    sqs = makeSqsClient(server.port);
    s3 = makeS3Client(server.port);

    const config = await s3.send(
      new GetBucketNotificationConfigurationCommand({ Bucket: "pg-notif-bucket" }),
    );
    expect(config.QueueConfigurations).toHaveLength(1);
    expect(config.QueueConfigurations![0].Id).toBe("pg-cfg");

    await s3.send(
      new PutObjectCommand({ Bucket: "pg-notif-bucket", Key: "after.txt", Body: "hello" }),
    );
    const recv = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl(), WaitTimeSeconds: 1 }),
    );
    expect(recv.Messages).toHaveLength(1);
    expect(JSON.parse(recv.Messages![0].Body!).Records[0].s3.object.key).toBe("after.txt");
    await server.stop();
  });
});
