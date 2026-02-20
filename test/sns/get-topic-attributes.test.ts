import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateTopicCommand,
  GetTopicAttributesCommand,
  SubscribeCommand,
  SetTopicAttributesCommand,
} from "@aws-sdk/client-sns";
import { CreateQueueCommand, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { createSnsClient, createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("GetTopicAttributes", () => {
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

  it("returns all default attributes for a new topic", async () => {
    const { TopicArn } = await sns.send(
      new CreateTopicCommand({ Name: "defaults-topic" }),
    );

    const result = await sns.send(
      new GetTopicAttributesCommand({ TopicArn: TopicArn! }),
    );
    const attrs = result.Attributes!;

    // Matches real AWS GetTopicAttributes response format
    // See: https://docs.aws.amazon.com/cli/latest/reference/sns/get-topic-attributes.html
    expect(attrs.TopicArn).toBe(TopicArn);
    expect(attrs.Owner).toBe("000000000000");
    expect(attrs.DisplayName).toBe("");
    expect(attrs.EffectiveDeliveryPolicy).toBe(
      JSON.stringify({
        http: {
          defaultHealthyRetryPolicy: {
            minDelayTarget: 20,
            maxDelayTarget: 20,
            numRetries: 3,
            numMaxDelayRetries: 0,
            numNoDelayRetries: 0,
            numMinDelayRetries: 0,
            backoffFunction: "linear",
          },
          disableSubscriptionOverrides: false,
        },
      }),
    );
    expect(attrs.SubscriptionsConfirmed).toBe("0");
    expect(attrs.SubscriptionsPending).toBe("0");
    expect(attrs.SubscriptionsDeleted).toBe("0");
    // DeliveryPolicy is not returned when not explicitly set (matches AWS)
    expect(attrs.DeliveryPolicy).toBeUndefined();
  });

  it("returns correct subscription counts after subscribing SQS queue", async () => {
    const { TopicArn } = await sns.send(
      new CreateTopicCommand({ Name: "sub-count-topic" }),
    );

    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({ QueueName: "sub-count-queue" }),
    );
    const queueAttrs = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }),
    );

    await sns.send(
      new SubscribeCommand({
        TopicArn: TopicArn!,
        Protocol: "sqs",
        Endpoint: queueAttrs.Attributes!.QueueArn,
      }),
    );

    const result = await sns.send(
      new GetTopicAttributesCommand({ TopicArn: TopicArn! }),
    );
    const attrs = result.Attributes!;

    // SQS subscriptions auto-confirm — matches real AWS behavior
    expect(attrs.SubscriptionsConfirmed).toBe("1");
    expect(attrs.SubscriptionsPending).toBe("0");
  });

  it("returns topic with Policy and subscription matching AWS format", async () => {
    const topicName = "autopilot-import";
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Id: "__default_policy_ID",
      Statement: [
        {
          Sid: "AllowSQSSubscription",
          Effect: "Allow",
          Principal: { AWS: "*" },
          Action: ["sns:Subscribe"],
          Resource: `arn:aws:sns:us-east-1:000000000000:${topicName}`,
          Condition: {
            StringLike: {
              "sns:Endpoint": ["arn:aws:sqs:*:*:autopilot-*"],
            },
          },
        },
      ],
    });

    const { TopicArn } = await sns.send(
      new CreateTopicCommand({ Name: topicName }),
    );
    await sns.send(
      new SetTopicAttributesCommand({
        TopicArn: TopicArn!,
        AttributeName: "Policy",
        AttributeValue: policy,
      }),
    );

    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({ QueueName: "autopilot-import-translation_storage" }),
    );
    const queueAttrs = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }),
    );
    await sns.send(
      new SubscribeCommand({
        TopicArn: TopicArn!,
        Protocol: "sqs",
        Endpoint: queueAttrs.Attributes!.QueueArn,
      }),
    );

    const result = await sns.send(
      new GetTopicAttributesCommand({ TopicArn: TopicArn! }),
    );
    const attrs = result.Attributes!;

    expect(attrs).toMatchObject({
      TopicArn: TopicArn,
      Owner: "000000000000",
      DisplayName: "",
      Policy: policy,
      SubscriptionsConfirmed: "1",
      SubscriptionsPending: "0",
      SubscriptionsDeleted: "0",
    });
    expect(attrs.EffectiveDeliveryPolicy).toBeDefined();
    expect(attrs.DeliveryPolicy).toBeUndefined();
  });

  it("returns DeliveryPolicy when explicitly set", async () => {
    const { TopicArn } = await sns.send(
      new CreateTopicCommand({ Name: "delivery-policy-topic" }),
    );
    const deliveryPolicy = JSON.stringify({
      http: {
        defaultHealthyRetryPolicy: {
          minDelayTarget: 10,
          maxDelayTarget: 30,
          numRetries: 5,
          backoffFunction: "exponential",
        },
      },
    });
    await sns.send(
      new SetTopicAttributesCommand({
        TopicArn: TopicArn!,
        AttributeName: "DeliveryPolicy",
        AttributeValue: deliveryPolicy,
      }),
    );

    const result = await sns.send(
      new GetTopicAttributesCommand({ TopicArn: TopicArn! }),
    );
    expect(result.Attributes!.DeliveryPolicy).toBe(deliveryPolicy);
  });

  it("counts pending subscriptions for non-SQS protocols", async () => {
    const { TopicArn } = await sns.send(
      new CreateTopicCommand({ Name: "pending-sub-topic" }),
    );

    // HTTP subscriptions are not auto-confirmed
    await sns.send(
      new SubscribeCommand({
        TopicArn: TopicArn!,
        Protocol: "http",
        Endpoint: "http://example.com/webhook",
      }),
    );

    const result = await sns.send(
      new GetTopicAttributesCommand({ TopicArn: TopicArn! }),
    );
    const attrs = result.Attributes!;

    expect(attrs.SubscriptionsConfirmed).toBe("0");
    expect(attrs.SubscriptionsPending).toBe("1");
  });

  it("preserves explicitly set DisplayName", async () => {
    const { TopicArn } = await sns.send(
      new CreateTopicCommand({ Name: "display-name-topic" }),
    );
    await sns.send(
      new SetTopicAttributesCommand({
        TopicArn: TopicArn!,
        AttributeName: "DisplayName",
        AttributeValue: "My Custom Name",
      }),
    );

    const result = await sns.send(
      new GetTopicAttributesCommand({ TopicArn: TopicArn! }),
    );
    expect(result.Attributes!.DisplayName).toBe("My Custom Name");
  });
});
