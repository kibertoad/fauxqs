/**
 * Queue Inspection — non-destructive inspection of SQS queue state,
 * available both programmatically and via HTTP endpoints.
 */
import { startFauxqs } from "fauxqs";
import { SQSClient, SendMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";

async function main() {
  const server = await startFauxqs({ port: 0, logger: false });

  const endpoint = `http://127.0.0.1:${server.port}`;
  const credentials = { accessKeyId: "test", secretAccessKey: "test" };
  const region = "us-east-1";

  const sqsClient = new SQSClient({ endpoint, region, credentials });

  // Create a queue with a delay to demonstrate all three message states
  server.createQueue("my-queue", {
    attributes: { VisibilityTimeout: "30" },
  });

  const queueUrl = `http://sqs.us-east-1.127.0.0.1:${server.port}/000000000000/my-queue`;

  // Send ready messages
  for (let i = 0; i < 3; i++) {
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: `ready-message-${i}`,
    }));
  }

  // Send a delayed message (per-message delay)
  await sqsClient.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: "delayed-message",
    DelaySeconds: 10,
  }));

  // Receive (but don't delete) to create an inflight message
  await sqsClient.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
  }));

  // ---------------------------------------------------------------
  // Programmatic inspection via server.inspectQueue()
  // ---------------------------------------------------------------

  const inspection = server.inspectQueue("my-queue");
  if (inspection) {
    console.log("=== Programmatic Inspection ===");
    console.log("Name:", inspection.name);
    console.log("URL:", inspection.url);
    console.log("ARN:", inspection.arn);
    console.log("Attributes:", JSON.stringify(inspection.attributes, null, 2));

    // Messages grouped by state
    console.log("\nReady messages:", inspection.messages.ready.length);
    for (const msg of inspection.messages.ready) {
      console.log(`  ID: ${msg.messageId}`);
      console.log(`  Body: ${msg.body}`);
      console.log(`  Sent: ${new Date(msg.sentTimestamp).toISOString()}`);
      console.log(`  Receive count: ${msg.approximateReceiveCount}`);
    }

    console.log("\nDelayed messages:", inspection.messages.delayed.length);
    for (const msg of inspection.messages.delayed) {
      console.log(`  ID: ${msg.messageId}`);
      console.log(`  Body: ${msg.body}`);
      if (msg.delayUntil) {
        console.log(`  Available at: ${new Date(msg.delayUntil).toISOString()}`);
      }
    }

    console.log("\nInflight messages:", inspection.messages.inflight.length);
    for (const entry of inspection.messages.inflight) {
      console.log(`  ID: ${entry.message.messageId}`);
      console.log(`  Body: ${entry.message.body}`);
      console.log(`  Receipt handle: ${entry.receiptHandle}`);
      console.log(`  Visible again at: ${new Date(entry.visibilityDeadline).toISOString()}`);
    }
  }

  // Returns undefined for non-existent queues
  const missing = server.inspectQueue("does-not-exist");
  console.log("\nNon-existent queue:", missing); // undefined

  // ---------------------------------------------------------------
  // HTTP inspection: GET /_fauxqs/queues
  // ---------------------------------------------------------------

  console.log("\n=== HTTP: List All Queues ===");

  const listResponse = await fetch(`${endpoint}/_fauxqs/queues`);
  const queues: Array<{
    name: string;
    url: string;
    arn: string;
    approximateMessageCount: number;
    approximateInflightCount: number;
    approximateDelayedCount: number;
  }> = await listResponse.json();

  for (const q of queues) {
    console.log(`\n${q.name}:`);
    console.log(`  URL: ${q.url}`);
    console.log(`  ARN: ${q.arn}`);
    console.log(`  Messages: ${q.approximateMessageCount}`);
    console.log(`  Inflight: ${q.approximateInflightCount}`);
    console.log(`  Delayed: ${q.approximateDelayedCount}`);
  }

  // ---------------------------------------------------------------
  // HTTP inspection: GET /_fauxqs/queues/:queueName
  // ---------------------------------------------------------------

  console.log("\n=== HTTP: Single Queue Detail ===");

  const detailResponse = await fetch(`${endpoint}/_fauxqs/queues/my-queue`);
  const detail = await detailResponse.json();
  console.log("Queue detail:", JSON.stringify(detail, null, 2));

  // 404 for non-existent queues
  const notFoundResponse = await fetch(`${endpoint}/_fauxqs/queues/nonexistent`);
  console.log("Not found status:", notFoundResponse.status); // 404
  const notFoundBody = await notFoundResponse.json();
  console.log("Not found body:", notFoundBody); // { error: "Queue 'nonexistent' not found" }

  await server.stop();
}

main().catch(console.error);
