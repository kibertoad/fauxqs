import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateTopicCommand,
  SubscribeCommand,
  SetSubscriptionAttributesCommand,
  GetSubscriptionAttributesCommand,
} from "@aws-sdk/client-sns";
import { CreateQueueCommand, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { createSnsClient, createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SNS Subscription Attribute Validation", () => {
  let server: FauxqsServer;
  let sns: ReturnType<typeof createSnsClient>;
  let sqs: ReturnType<typeof createSqsClient>;
  let subscriptionArn: string;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sns = createSnsClient(server.port);
    sqs = createSqsClient(server.port);

    // Create topic and queue
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "sub-attr-topic" }),
    );
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "sub-attr-queue" }),
    );
    const queueAttrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl,
        AttributeNames: ["QueueArn"],
      }),
    );

    const sub = await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn,
        Protocol: "sqs",
        Endpoint: queueAttrs.Attributes!.QueueArn,
      }),
    );
    subscriptionArn = sub.SubscriptionArn!;
  });

  afterAll(async () => {
    sns.destroy();
    sqs.destroy();
    await server.stop();
  });

  it("accepts and persists FilterPolicy", async () => {
    const filterPolicy = JSON.stringify({ color: ["red"] });
    await sns.send(
      new SetSubscriptionAttributesCommand({
        SubscriptionArn: subscriptionArn,
        AttributeName: "FilterPolicy",
        AttributeValue: filterPolicy,
      }),
    );

    const attrs = await sns.send(
      new GetSubscriptionAttributesCommand({
        SubscriptionArn: subscriptionArn,
      }),
    );
    expect(attrs.Attributes!.FilterPolicy).toBe(filterPolicy);
  });

  it("accepts and persists FilterPolicyScope", async () => {
    await sns.send(
      new SetSubscriptionAttributesCommand({
        SubscriptionArn: subscriptionArn,
        AttributeName: "FilterPolicyScope",
        AttributeValue: "MessageBody",
      }),
    );

    const attrs = await sns.send(
      new GetSubscriptionAttributesCommand({
        SubscriptionArn: subscriptionArn,
      }),
    );
    expect(attrs.Attributes!.FilterPolicyScope).toBe("MessageBody");
  });

  it("accepts and persists RawMessageDelivery", async () => {
    await sns.send(
      new SetSubscriptionAttributesCommand({
        SubscriptionArn: subscriptionArn,
        AttributeName: "RawMessageDelivery",
        AttributeValue: "true",
      }),
    );

    const attrs = await sns.send(
      new GetSubscriptionAttributesCommand({
        SubscriptionArn: subscriptionArn,
      }),
    );
    expect(attrs.Attributes!.RawMessageDelivery).toBe("true");
  });

  it("accepts RedrivePolicy", async () => {
    await sns.send(
      new SetSubscriptionAttributesCommand({
        SubscriptionArn: subscriptionArn,
        AttributeName: "RedrivePolicy",
        AttributeValue: "{}",
      }),
    );
  });

  it("accepts DeliveryPolicy", async () => {
    await sns.send(
      new SetSubscriptionAttributesCommand({
        SubscriptionArn: subscriptionArn,
        AttributeName: "DeliveryPolicy",
        AttributeValue: "{}",
      }),
    );
  });

  it("accepts SubscriptionRoleArn", async () => {
    await sns.send(
      new SetSubscriptionAttributesCommand({
        SubscriptionArn: subscriptionArn,
        AttributeName: "SubscriptionRoleArn",
        AttributeValue: "arn:aws:iam::000000000000:role/test",
      }),
    );
  });

  it("rejects invalid attribute name", async () => {
    await expect(
      sns.send(
        new SetSubscriptionAttributesCommand({
          SubscriptionArn: subscriptionArn,
          AttributeName: "InvalidAttribute",
          AttributeValue: "value",
        }),
      ),
    ).rejects.toThrow("Invalid attribute name");
  });

  it("rejects read-only attribute name", async () => {
    await expect(
      sns.send(
        new SetSubscriptionAttributesCommand({
          SubscriptionArn: subscriptionArn,
          AttributeName: "TopicArn",
          AttributeValue: "arn:aws:sns:us-east-1:000000000000:test",
        }),
      ),
    ).rejects.toThrow("Invalid attribute name");
  });
});
