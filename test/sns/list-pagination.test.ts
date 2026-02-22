import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateTopicCommand,
  ListTopicsCommand,
  SubscribeCommand,
  ListSubscriptionsCommand,
  ListSubscriptionsByTopicCommand,
} from "@aws-sdk/client-sns";
import { CreateQueueCommand } from "@aws-sdk/client-sqs";
import { createSnsClient, createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SNS List Pagination", () => {
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

  describe("ListTopics pagination", () => {
    it("paginates when there are more than 100 topics", async () => {
      // Create 105 topics
      for (let i = 0; i < 105; i++) {
        await sns.send(
          new CreateTopicCommand({ Name: `page-topic-${String(i).padStart(3, "0")}` }),
        );
      }

      // First page should have 100 topics and a NextToken
      const page1 = await sns.send(new ListTopicsCommand({}));
      expect(page1.Topics).toHaveLength(100);
      expect(page1.NextToken).toBeDefined();

      // Second page should have remaining 5 topics and no NextToken
      const page2 = await sns.send(
        new ListTopicsCommand({ NextToken: page1.NextToken }),
      );
      expect(page2.Topics).toHaveLength(5);
      expect(page2.NextToken).toBeUndefined();

      // All topic ARNs should be unique
      const allArns = [
        ...page1.Topics!.map((t) => t.TopicArn),
        ...page2.Topics!.map((t) => t.TopicArn),
      ];
      expect(new Set(allArns).size).toBe(105);
    });
  });

  describe("ListSubscriptions pagination", () => {
    it("paginates when there are more than 100 subscriptions", async () => {
      // Create a topic and a queue for subscriptions
      const topicResult = await sns.send(
        new CreateTopicCommand({ Name: "sub-page-topic" }),
      );
      const topicArn = topicResult.TopicArn!;

      // Create 105 queues and subscribe each to the topic
      for (let i = 0; i < 105; i++) {
        const queueName = `sub-page-queue-${String(i).padStart(3, "0")}`;
        const queueResult = await sqs.send(
          new CreateQueueCommand({ QueueName: queueName }),
        );
        await sns.send(
          new SubscribeCommand({
            TopicArn: topicArn,
            Protocol: "sqs",
            Endpoint: `arn:aws:sqs:us-east-1:000000000000:${queueName}`,
          }),
        );
      }

      // First page
      const page1 = await sns.send(new ListSubscriptionsCommand({}));
      expect(page1.Subscriptions).toHaveLength(100);
      expect(page1.NextToken).toBeDefined();

      // Second page
      const page2 = await sns.send(
        new ListSubscriptionsCommand({ NextToken: page1.NextToken }),
      );
      expect(page2.Subscriptions).toHaveLength(5);
      expect(page2.NextToken).toBeUndefined();
    });
  });

  describe("ListSubscriptionsByTopic pagination", () => {
    it("paginates subscriptions for a specific topic", async () => {
      const topicResult = await sns.send(
        new CreateTopicCommand({ Name: "bytopic-page-topic" }),
      );
      const topicArn = topicResult.TopicArn!;

      for (let i = 0; i < 105; i++) {
        const queueName = `bytopic-page-queue-${String(i).padStart(3, "0")}`;
        await sqs.send(new CreateQueueCommand({ QueueName: queueName }));
        await sns.send(
          new SubscribeCommand({
            TopicArn: topicArn,
            Protocol: "sqs",
            Endpoint: `arn:aws:sqs:us-east-1:000000000000:${queueName}`,
          }),
        );
      }

      const page1 = await sns.send(
        new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }),
      );
      expect(page1.Subscriptions).toHaveLength(100);
      expect(page1.NextToken).toBeDefined();

      const page2 = await sns.send(
        new ListSubscriptionsByTopicCommand({
          TopicArn: topicArn,
          NextToken: page1.NextToken,
        }),
      );
      expect(page2.Subscriptions).toHaveLength(5);
      expect(page2.NextToken).toBeUndefined();
    });
  });
});
