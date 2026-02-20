import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateTopicCommand,
  SubscribeCommand,
  ConfirmSubscriptionCommand,
} from "@aws-sdk/client-sns";
import { CreateQueueCommand } from "@aws-sdk/client-sqs";
import { createSnsClient, createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SNS ConfirmSubscription", () => {
  let server: FauxqsServer;
  let sns: ReturnType<typeof createSnsClient>;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sns = createSnsClient(server.port);
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sns.destroy();
    sqs.destroy();
    await server.stop();
  });

  it("confirms an existing subscription and returns its ARN", async () => {
    const topic = await sns.send(new CreateTopicCommand({ Name: "confirm-test-topic" }));
    await sqs.send(new CreateQueueCommand({ QueueName: "confirm-test-queue" }));

    const sub = await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: `arn:aws:sqs:us-east-1:000000000000:confirm-test-queue`,
      }),
    );

    const result = await sns.send(
      new ConfirmSubscriptionCommand({
        TopicArn: topic.TopicArn!,
        Token: sub.SubscriptionArn!,
      }),
    );

    expect(result.SubscriptionArn).toBe(sub.SubscriptionArn);
  });

  it("returns PendingConfirmation when topic has no subscriptions", async () => {
    const topic = await sns.send(new CreateTopicCommand({ Name: "no-sub-confirm-topic" }));

    const result = await sns.send(
      new ConfirmSubscriptionCommand({
        TopicArn: topic.TopicArn!,
        Token: "dummy-token",
      }),
    );

    expect(result.SubscriptionArn).toBe("PendingConfirmation");
  });
});
