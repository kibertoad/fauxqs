/**
 * Test helper — starts fauxqs in library mode and wires up the app.
 *
 * Each test file calls createTestContext() to get an isolated fauxqs instance
 * on a random port, with the spy enabled and resources pre-created.
 * No Docker, no shared state, no port conflicts.
 */
import { startFauxqs, type FauxqsServer } from "fauxqs";
import { buildApp, type AppConfig } from "../src/app.ts";
import type { FastifyInstance } from "fastify";

export interface TestContext {
  fauxqs: FauxqsServer;
  app: FastifyInstance;
}

export async function createTestContext(): Promise<TestContext> {
  // 1. Start fauxqs with spy enabled, random port, no logs
  const fauxqs = await startFauxqs({
    port: 0,
    logger: false,
    messageSpies: true,
  });

  // 2. Pre-create resources via the programmatic API — no SDK roundtrips needed.
  //
  //    createQueue() supports the same attributes as the SDK: VisibilityTimeout,
  //    DelaySeconds, RedrivePolicy, FifoQueue, etc.
  //
  //    setup() is a convenience method that creates multiple resources at once
  //    in dependency order (queues → topics → subscriptions → buckets).

  fauxqs.setup({
    queues: [
      // Main notification queue
      { name: "file-notifications" },
      // DLQ for the audit queue — messages that fail processing land here
      { name: "audit-dlq" },
      // Audit queue with DLQ and short visibility timeout (for testing DLQ flow)
      {
        name: "audit-events",
        attributes: {
          VisibilityTimeout: "0",
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: "arn:aws:sqs:us-east-1:000000000000:audit-dlq",
            maxReceiveCount: "1",
          }),
        },
      },
      // Queue subscribed to SNS topic — receives fan-out messages
      { name: "analytics-events" },
    ],
    topics: [
      { name: "file-events" },
    ],
    subscriptions: [
      // SNS → SQS fan-out: file-events topic delivers to both queues
      { topic: "file-events", queue: "audit-events" },
      {
        topic: "file-events",
        queue: "analytics-events",
        attributes: {
          // Only receive .json file events via filter policy
          FilterPolicy: JSON.stringify({ fileExtension: ["json"] }),
        },
      },
    ],
    buckets: ["app-files"],
  });

  // 3. Build the application under test, pointed at the fauxqs instance.
  //    S3 uses http://s3.localhost:PORT — interceptLocalhostDns() in the vitest
  //    setupFile resolves *.localhost to 127.0.0.1, so virtual-hosted-style S3
  //    works without forcePathStyle or custom request handlers.
  const config: AppConfig = {
    awsEndpoint: `http://127.0.0.1:${fauxqs.port}`,
    s3Endpoint: `http://s3.localhost:${fauxqs.port}`,
    bucket: "app-files",
    queueUrl: `http://sqs.us-east-1.localhost:${fauxqs.port}/000000000000/file-notifications`,
    topicArn: "arn:aws:sns:us-east-1:000000000000:file-events",
  };

  const app = buildApp(config);
  await app.ready();

  return { fauxqs, app };
}
