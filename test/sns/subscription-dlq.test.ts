import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateTopicCommand,
  SubscribeCommand,
  PublishCommand,
  SetSubscriptionAttributesCommand,
} from "@aws-sdk/client-sns";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { createSnsClient, createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

async function createQueueWithArn(
  sqs: ReturnType<typeof createSqsClient>,
  name: string,
): Promise<{ url: string; arn: string }> {
  const queue = await sqs.send(new CreateQueueCommand({ QueueName: name }));
  const attrs = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queue.QueueUrl!,
      AttributeNames: ["QueueArn"],
    }),
  );
  return { url: queue.QueueUrl!, arn: attrs.Attributes!.QueueArn! };
}

describe("SNS Subscription DLQ (RedrivePolicy)", () => {
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

  it("routes wrapped delivery to subscription DLQ when endpoint queue is gone", async () => {
    const topic = await sns.send(new CreateTopicCommand({ Name: "sub-dlq-wrapped" }));
    const endpoint = await createQueueWithArn(sqs, "sub-dlq-wrapped-endpoint");
    const dlq = await createQueueWithArn(sqs, "sub-dlq-wrapped-dlq");

    const sub = await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: endpoint.arn,
      }),
    );
    await sns.send(
      new SetSubscriptionAttributesCommand({
        SubscriptionArn: sub.SubscriptionArn!,
        AttributeName: "RedrivePolicy",
        AttributeValue: JSON.stringify({ deadLetterTargetArn: dlq.arn }),
      }),
    );

    // Force a delivery failure: the subscription still exists but the
    // endpoint queue does not.
    await sqs.send(new DeleteQueueCommand({ QueueUrl: endpoint.url }));

    await sns.send(
      new PublishCommand({
        TopicArn: topic.TopicArn!,
        Message: "sub-dlq-1",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: dlq.url,
        MaxNumberOfMessages: 1,
        MessageAttributeNames: ["All"],
      }),
    );

    expect(received.Messages).toHaveLength(1);
    const envelope = JSON.parse(received.Messages![0].Body!);
    expect(envelope.Type).toBe("Notification");
    expect(envelope.Message).toBe("sub-dlq-1");
    expect(envelope.TopicArn).toBe(topic.TopicArn);

    const attrs = received.Messages![0].MessageAttributes!;
    expect(attrs.ErrorCode?.StringValue).toBe(
      "AWS.SimpleQueueService.NonExistentQueue",
    );
    expect(attrs.ErrorMessage?.StringValue).toBe(
      "The specified queue does not exist or you do not have access to it.",
    );
    expect(attrs.RequestID?.StringValue).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("preserves RawMessageDelivery body when routing to DLQ", async () => {
    const topic = await sns.send(new CreateTopicCommand({ Name: "sub-dlq-raw" }));
    const endpoint = await createQueueWithArn(sqs, "sub-dlq-raw-endpoint");
    const dlq = await createQueueWithArn(sqs, "sub-dlq-raw-dlq");

    const sub = await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: endpoint.arn,
        Attributes: {
          RawMessageDelivery: "true",
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn }),
        },
      }),
    );
    expect(sub.SubscriptionArn).toBeDefined();

    await sqs.send(new DeleteQueueCommand({ QueueUrl: endpoint.url }));

    await sns.send(
      new PublishCommand({ TopicArn: topic.TopicArn!, Message: "raw-dlq-payload" }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlq.url, MaxNumberOfMessages: 1 }),
    );

    expect(received.Messages).toHaveLength(1);
    expect(received.Messages![0].Body).toBe("raw-dlq-payload");
  });

  it("drops the message when endpoint is missing and no RedrivePolicy is set", async () => {
    const topic = await sns.send(new CreateTopicCommand({ Name: "sub-dlq-none" }));
    const endpoint = await createQueueWithArn(sqs, "sub-dlq-none-endpoint");
    const observer = await createQueueWithArn(sqs, "sub-dlq-none-observer");

    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: endpoint.arn,
      }),
    );
    await sqs.send(new DeleteQueueCommand({ QueueUrl: endpoint.url }));

    await sns.send(
      new PublishCommand({ TopicArn: topic.TopicArn!, Message: "lost" }),
    );

    // Nothing should arrive in an unrelated queue either — sanity check that
    // the message is silently dropped (existing behaviour) when no DLQ.
    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: observer.url, WaitTimeSeconds: 0 }),
    );
    expect(received.Messages ?? []).toHaveLength(0);
  });

  it("drops the message when RedrivePolicy targets a non-existent DLQ", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "sub-dlq-missing-target" }),
    );
    const endpoint = await createQueueWithArn(sqs, "sub-dlq-missing-target-endpoint");

    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: endpoint.arn,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn:
              "arn:aws:sqs:us-east-1:000000000000:does-not-exist-dlq",
          }),
        },
      }),
    );
    await sqs.send(new DeleteQueueCommand({ QueueUrl: endpoint.url }));

    // Should not throw — the publish succeeds, the message is simply dropped
    // because there's nowhere left to route it. This matches the
    // best-effort nature of SNS delivery.
    await expect(
      sns.send(new PublishCommand({ TopicArn: topic.TopicArn!, Message: "lost" })),
    ).resolves.toBeDefined();
  });

  it("does not route to DLQ when delivery succeeds normally", async () => {
    const topic = await sns.send(new CreateTopicCommand({ Name: "sub-dlq-happy" }));
    const endpoint = await createQueueWithArn(sqs, "sub-dlq-happy-endpoint");
    const dlq = await createQueueWithArn(sqs, "sub-dlq-happy-dlq");

    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: endpoint.arn,
        Attributes: {
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn }),
        },
      }),
    );

    await sns.send(
      new PublishCommand({ TopicArn: topic.TopicArn!, Message: "happy path" }),
    );

    const endpointMsg = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: endpoint.url }),
    );
    expect(endpointMsg.Messages).toHaveLength(1);

    const dlqMsg = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlq.url, WaitTimeSeconds: 0 }),
    );
    expect(dlqMsg.Messages ?? []).toHaveLength(0);
  });

  it("invalidates the cached RedrivePolicy when SetSubscriptionAttributes changes it", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "sub-dlq-cache-invalidate" }),
    );
    const endpoint = await createQueueWithArn(sqs, "sub-dlq-cache-endpoint");
    const dlqA = await createQueueWithArn(sqs, "sub-dlq-cache-a");
    const dlqB = await createQueueWithArn(sqs, "sub-dlq-cache-b");

    const sub = await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: endpoint.arn,
        Attributes: {
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqA.arn }),
        },
      }),
    );

    await sqs.send(new DeleteQueueCommand({ QueueUrl: endpoint.url }));

    await sns.send(
      new PublishCommand({ TopicArn: topic.TopicArn!, Message: "first" }),
    );
    const inA = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqA.url }));
    expect(inA.Messages).toHaveLength(1);

    // Repoint the RedrivePolicy at the second DLQ. Without cache
    // invalidation we'd keep delivering to dlqA.
    await sns.send(
      new SetSubscriptionAttributesCommand({
        SubscriptionArn: sub.SubscriptionArn!,
        AttributeName: "RedrivePolicy",
        AttributeValue: JSON.stringify({ deadLetterTargetArn: dlqB.arn }),
      }),
    );
    await sns.send(
      new PublishCommand({ TopicArn: topic.TopicArn!, Message: "second" }),
    );

    const inB = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqB.url }));
    expect(inB.Messages).toHaveLength(1);
    const envelope = JSON.parse(inB.Messages![0].Body!);
    expect(envelope.Message).toBe("second");
  });
});
