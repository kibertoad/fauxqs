/**
 * Docker Compose — container-to-container communication with fauxqs.
 *
 * See docker-compose.yml in this directory for the compose file.
 *
 * Start the stack:
 *   docker compose -f examples/alternatives/docker/container-to-container/docker-compose.yml up
 *
 * The compose setup provides:
 * - fauxqs service with health check and init config volume mount
 * - Application service that depends on fauxqs being healthy
 * - Container-to-container networking (app connects via service name)
 *
 * The init config (init.json) is mounted into the fauxqs container,
 * so queues, topics, subscriptions, and buckets are created on startup.
 *
 * Key differences from standalone Docker:
 * - Endpoint uses the Docker service name (e.g. http://fauxqs:4566)
 * - FAUXQS_HOST is set to the service name so queue URLs resolve correctly
 * - No need to create resources via SDK — init config handles that
 */
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

async function main() {
  // Inside a docker-compose network, use the service name as the hostname.
  // The FAUXQS_ENDPOINT env var is set in docker-compose.yml.
  const endpoint = process.env.FAUXQS_ENDPOINT ?? "http://fauxqs:4566";
  const credentials = { accessKeyId: "test", secretAccessKey: "test" };
  const region = "us-east-1";

  const sqsClient = new SQSClient({ endpoint, region, credentials });
  const snsClient = new SNSClient({ endpoint, region, credentials });
  const s3Client = new S3Client({ endpoint, region, credentials, forcePathStyle: true });

  // --- SQS ---
  // Resources from init.json are already available — no need to create them.
  // The queue URL uses FAUXQS_HOST (set to "fauxqs" in compose), so it resolves
  // correctly within the Docker network.

  const queueUrl = `http://sqs.us-east-1.fauxqs:4566/000000000000/orders`;

  await sqsClient.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ orderId: "ORD-001", action: "process" }),
  }));

  const result = await sqsClient.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 5,
    MessageSystemAttributeNames: ["All"],
  }));

  if (result.Messages?.[0]) {
    console.log("Received:", result.Messages[0].Body);
    await sqsClient.send(new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: result.Messages[0].ReceiptHandle!,
    }));
  }

  // --- SNS ---
  // The "order-events" topic and its subscriptions are also from init.json

  await snsClient.send(new PublishCommand({
    TopicArn: "arn:aws:sns:us-east-1:000000000000:order-events",
    Message: JSON.stringify({ orderId: "ORD-002", status: "shipped" }),
    MessageAttributes: {
      eventType: { DataType: "String", StringValue: "order.updated" },
    },
  }));

  // Messages published to the topic are routed to subscribed queues
  // based on the filter policies defined in init.json

  const notificationUrl = `http://sqs.us-east-1.fauxqs:4566/000000000000/notifications`;
  const notification = await sqsClient.send(new ReceiveMessageCommand({
    QueueUrl: notificationUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 5,
  }));
  console.log("Notification:", notification.Messages?.[0]?.Body);

  // --- S3 ---
  // The "uploads" bucket is also from init.json

  await s3Client.send(new PutObjectCommand({
    Bucket: "uploads",
    Key: "orders/ORD-002/invoice.pdf",
    Body: Buffer.from("fake-pdf-data"),
    ContentType: "application/pdf",
  }));

  const s3Result = await s3Client.send(new GetObjectCommand({
    Bucket: "uploads",
    Key: "orders/ORD-002/invoice.pdf",
  }));
  console.log("S3 content type:", s3Result.ContentType);

  // --- Health check ---

  const health = await fetch(`${endpoint}/health`);
  const healthBody = await health.json();
  console.log("Health:", healthBody); // { status: "ok" }
}

main().catch(console.error);
