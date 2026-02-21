/**
 * Init Config — pre-create queues, topics, subscriptions, and buckets
 * on server startup using file-based or inline configuration.
 */
import { startFauxqs } from "fauxqs";
import type { FauxqsInitConfig } from "fauxqs";
import { SQSClient, SendMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function fileBasedInit() {
  // ---------------------------------------------------------------
  // File-based init — point to a JSON file
  // ---------------------------------------------------------------

  // Pass a path to a JSON file (see ../config/init.json)
  const server = await startFauxqs({
    port: 0,
    logger: false,
    init: join(__dirname, "..", "config", "init.json"),
  });

  // All resources from init.json are now available
  const endpoint = `http://127.0.0.1:${server.port}`;
  const credentials = { accessKeyId: "test", secretAccessKey: "test" };
  const region = "us-east-1";

  const sqsClient = new SQSClient({ endpoint, region, credentials });

  // The "orders" queue from init.json is ready to use
  const queueUrl = `http://sqs.us-east-1.127.0.0.1:${server.port}/000000000000/orders`;
  await sqsClient.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ orderId: "1001" }),
  }));

  const result = await sqsClient.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 1,
  }));
  console.log("Received from init'd queue:", result.Messages?.[0]?.Body);

  await server.stop();
}

async function inlineInit() {
  // ---------------------------------------------------------------
  // Inline init config — pass the config object directly
  // ---------------------------------------------------------------

  const config: FauxqsInitConfig = {
    region: "us-west-2",
    queues: [
      { name: "payments" },
      { name: "payments-dlq" },
      {
        name: "payments-processor",
        attributes: {
          VisibilityTimeout: "120",
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: "arn:aws:sqs:us-west-2:000000000000:payments-dlq",
            maxReceiveCount: "5",
          }),
        },
        tags: { service: "payments" },
      },
    ],
    topics: [
      { name: "payment-events" },
    ],
    subscriptions: [
      {
        topic: "payment-events",
        queue: "payments",
        attributes: {
          FilterPolicy: JSON.stringify({
            eventType: ["payment.completed", "payment.refunded"],
          }),
        },
      },
      {
        topic: "payment-events",
        queue: "payments-processor",
        attributes: {
          RawMessageDelivery: "true",
        },
      },
    ],
    buckets: ["payment-receipts"],
  };

  const server = await startFauxqs({
    port: 0,
    logger: false,
    init: config,
  });

  console.log("Server started with inline config on port", server.port);

  await server.stop();
}

async function dlqChainSetup() {
  // ---------------------------------------------------------------
  // DLQ chain — main queue → DLQ → DLQ-DLQ
  // ---------------------------------------------------------------

  const config: FauxqsInitConfig = {
    queues: [
      // DLQ targets must be created before the queues that reference them.
      // Init config creates queues in array order, so list targets first.
      { name: "final-dlq" },
      {
        name: "first-dlq",
        attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: "arn:aws:sqs:us-east-1:000000000000:final-dlq",
            maxReceiveCount: "3",
          }),
        },
      },
      {
        name: "main-queue",
        attributes: {
          VisibilityTimeout: "10",
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: "arn:aws:sqs:us-east-1:000000000000:first-dlq",
            maxReceiveCount: "2",
          }),
        },
      },
    ],
  };

  const server = await startFauxqs({
    port: 0,
    logger: false,
    init: config,
  });

  console.log("DLQ chain configured");

  await server.stop();
}

async function setupIdempotency() {
  // ---------------------------------------------------------------
  // server.setup() is idempotent — safe to call multiple times
  // ---------------------------------------------------------------

  const server = await startFauxqs({ port: 0, logger: false });

  const config: FauxqsInitConfig = {
    queues: [{ name: "idempotent-queue" }],
    topics: [{ name: "idempotent-topic" }],
    subscriptions: [{ topic: "idempotent-topic", queue: "idempotent-queue" }],
    buckets: ["idempotent-bucket"],
  };

  // First call creates everything
  server.setup(config);

  // Second call is a no-op — existing resources are skipped
  server.setup(config);

  // Send a message to prove the queue works
  const endpoint = `http://127.0.0.1:${server.port}`;
  const sqsClient = new SQSClient({ endpoint, region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });

  await sqsClient.send(new SendMessageCommand({
    QueueUrl: `http://sqs.us-east-1.127.0.0.1:${server.port}/000000000000/idempotent-queue`,
    MessageBody: "still works after double setup",
  }));

  // ---------------------------------------------------------------
  // Purge + re-apply pattern (useful between test suites)
  // ---------------------------------------------------------------

  server.purgeAll();   // Clears all state
  server.setup(config); // Re-creates resources from scratch

  console.log("Purge + re-apply complete");

  await server.stop();
}

async function main() {
  await fileBasedInit();
  await inlineInit();
  await dlqChainSetup();
  await setupIdempotency();
}

main().catch(console.error);
