/**
 * Programmatic API — start a fauxqs server, create resources, use the SDK,
 * inspect queues, purge state, and apply setup configs.
 */
import { startFauxqs } from "fauxqs";
import type { FauxqsServer, FauxqsInitConfig } from "fauxqs";
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

async function main() {
  // Start the server on a random port with logging disabled
  const server: FauxqsServer = await startFauxqs({
    port: 0,
    logger: false,
  });

  const endpoint = `http://127.0.0.1:${server.port}`;
  const credentials = { accessKeyId: "test", secretAccessKey: "test" };
  const region = "us-east-1";

  // --- Create resources programmatically (no SDK calls needed) ---

  server.createQueue("my-queue");
  server.createQueue("my-dlq");

  // Queue with custom attributes and a DLQ
  server.createQueue("my-worker-queue", {
    attributes: {
      VisibilityTimeout: "60",
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: "arn:aws:sqs:us-east-1:000000000000:my-dlq",
        maxReceiveCount: "3",
      }),
    },
    tags: { environment: "dev" },
  });

  server.createTopic("my-topic");
  server.createTopic("my-tagged-topic", {
    tags: { team: "platform" },
  });

  // Subscribe a queue to a topic
  server.subscribe({ topic: "my-topic", queue: "my-queue" });

  // Subscribe with filter policy
  server.subscribe({
    topic: "my-topic",
    queue: "my-worker-queue",
    attributes: {
      FilterPolicy: JSON.stringify({ eventType: ["order.created"] }),
    },
  });

  server.createBucket("my-bucket");

  // --- Use the AWS SDK clients ---

  const sqsClient = new SQSClient({ endpoint, region, credentials });
  const snsClient = new SNSClient({ endpoint, region, credentials });
  const s3Client = new S3Client({ endpoint, region, credentials, forcePathStyle: true });

  // SQS: Send and receive a message
  const queueUrl = `http://sqs.us-east-1.127.0.0.1:${server.port}/000000000000/my-queue`;
  await sqsClient.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ orderId: "123", action: "process" }),
  }));

  const receiveResult = await sqsClient.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 1,
  }));

  if (receiveResult.Messages?.[0]) {
    const msg = receiveResult.Messages[0];
    console.log("Received:", msg.Body);

    await sqsClient.send(new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: msg.ReceiptHandle!,
    }));
  }

  // SNS: Publish to a topic (fans out to subscribed queues)
  await snsClient.send(new PublishCommand({
    TopicArn: "arn:aws:sns:us-east-1:000000000000:my-topic",
    Message: JSON.stringify({ orderId: "456" }),
    MessageAttributes: {
      eventType: { DataType: "String", StringValue: "order.created" },
    },
  }));

  // S3: Upload and download an object
  await s3Client.send(new PutObjectCommand({
    Bucket: "my-bucket",
    Key: "data/report.json",
    Body: Buffer.from(JSON.stringify({ total: 42 })),
    ContentType: "application/json",
  }));

  const getResult = await s3Client.send(new GetObjectCommand({
    Bucket: "my-bucket",
    Key: "data/report.json",
  }));
  const body = await getResult.Body?.transformToString();
  console.log("S3 object:", body);

  // --- Inspect queue state (non-destructive) ---

  const inspection = server.inspectQueue("my-queue");
  if (inspection) {
    console.log("Queue:", inspection.name);
    console.log("URL:", inspection.url);
    console.log("ARN:", inspection.arn);
    console.log("Ready messages:", inspection.messages.ready.length);
    console.log("Delayed messages:", inspection.messages.delayed.length);
    console.log("Inflight messages:", inspection.messages.inflight.length);

    // Access message details
    for (const msg of inspection.messages.ready) {
      console.log(`  - ${msg.messageId}: ${msg.body}`);
    }
    for (const entry of inspection.messages.inflight) {
      console.log(`  - inflight: ${entry.message.messageId}, receipt: ${entry.receiptHandle}`);
    }
  }

  // --- Apply a setup config (idempotent) ---

  const config: FauxqsInitConfig = {
    queues: [
      { name: "another-queue" },
      { name: "my-queue" }, // Already exists — skipped, not an error
    ],
    topics: [{ name: "another-topic" }],
    subscriptions: [{ topic: "another-topic", queue: "another-queue" }],
    buckets: ["another-bucket"],
  };
  server.setup(config);

  // --- Purge all state ---

  server.purgeAll(); // Clears all queues, topics, subscriptions, and buckets

  // --- Stop the server ---

  await server.stop();
}

main().catch(console.error);
