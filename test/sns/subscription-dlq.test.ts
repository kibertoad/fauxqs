import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateTopicCommand,
  SubscribeCommand,
  PublishCommand,
  PublishBatchCommand,
  SetSubscriptionAttributesCommand,
} from "@aws-sdk/client-sns";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";
import { createSnsClient, createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

async function createQueueWithArn(
  sqs: ReturnType<typeof createSqsClient>,
  name: string,
  attributes?: Record<string, string>,
): Promise<{ url: string; arn: string }> {
  const queue = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
  );
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

  it("adds AWS.SNS.MessageId and AWS.SNS.TopicARN attributes on the DLQ message", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "sub-dlq-correlation" }),
    );
    const endpoint = await createQueueWithArn(sqs, "sub-dlq-correlation-endpoint");
    const dlq = await createQueueWithArn(sqs, "sub-dlq-correlation-dlq");

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
    await sqs.send(new DeleteQueueCommand({ QueueUrl: endpoint.url }));

    const published = await sns.send(
      new PublishCommand({ TopicArn: topic.TopicArn!, Message: "with-correlation" }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: dlq.url,
        MaxNumberOfMessages: 1,
        MessageAttributeNames: ["All"],
      }),
    );
    expect(received.Messages).toHaveLength(1);
    const attrs = received.Messages![0].MessageAttributes!;
    expect(attrs["AWS.SNS.MessageId"]?.StringValue).toBe(published.MessageId);
    expect(attrs["AWS.SNS.TopicARN"]?.StringValue).toBe(topic.TopicArn);
  });

  it("uses a single RequestID for all DLQ-routed deliveries from one publish", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "sub-dlq-shared-request-id" }),
    );
    const endpointA = await createQueueWithArn(sqs, "sub-dlq-shared-a-endpoint");
    const endpointB = await createQueueWithArn(sqs, "sub-dlq-shared-b-endpoint");
    const dlqA = await createQueueWithArn(sqs, "sub-dlq-shared-a-dlq");
    const dlqB = await createQueueWithArn(sqs, "sub-dlq-shared-b-dlq");

    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: endpointA.arn,
        Attributes: {
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqA.arn }),
        },
      }),
    );
    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: endpointB.arn,
        Attributes: {
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqB.arn }),
        },
      }),
    );
    await sqs.send(new DeleteQueueCommand({ QueueUrl: endpointA.url }));
    await sqs.send(new DeleteQueueCommand({ QueueUrl: endpointB.url }));

    await sns.send(
      new PublishCommand({ TopicArn: topic.TopicArn!, Message: "fan-out" }),
    );

    const inA = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlqA.url, MessageAttributeNames: ["All"] }),
    );
    const inB = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlqB.url, MessageAttributeNames: ["All"] }),
    );
    expect(inA.Messages).toHaveLength(1);
    expect(inB.Messages).toHaveLength(1);
    const reqIdA = inA.Messages![0].MessageAttributes!.RequestID?.StringValue;
    const reqIdB = inB.Messages![0].MessageAttributes!.RequestID?.StringValue;
    expect(reqIdA).toBeDefined();
    expect(reqIdA).toBe(reqIdB);
  });

  it("does not route filtered-out messages to the DLQ", async () => {
    const topic = await sns.send(new CreateTopicCommand({ Name: "sub-dlq-filtered" }));
    const endpoint = await createQueueWithArn(sqs, "sub-dlq-filtered-endpoint");
    const dlq = await createQueueWithArn(sqs, "sub-dlq-filtered-dlq");

    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: endpoint.arn,
        Attributes: {
          FilterPolicy: JSON.stringify({ color: ["blue"] }),
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn }),
        },
      }),
    );
    await sqs.send(new DeleteQueueCommand({ QueueUrl: endpoint.url }));

    // Publish a message that doesn't match the filter — should be dropped
    // entirely (filter wins before delivery resolution), not redriven.
    await sns.send(
      new PublishCommand({
        TopicArn: topic.TopicArn!,
        Message: "filtered out",
        MessageAttributes: {
          color: { DataType: "String", StringValue: "red" },
        },
      }),
    );

    const inDlq = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlq.url, WaitTimeSeconds: 0 }),
    );
    expect(inDlq.Messages ?? []).toHaveLength(0);
  });

  it("routes only the subscribers with a configured DLQ when fanning out to a mix", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "sub-dlq-mixed-subs" }),
    );
    const endpointWithDlq = await createQueueWithArn(sqs, "sub-dlq-mixed-with");
    const endpointWithoutDlq = await createQueueWithArn(sqs, "sub-dlq-mixed-without");
    const dlq = await createQueueWithArn(sqs, "sub-dlq-mixed-dlq");

    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: endpointWithDlq.arn,
        Attributes: {
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn }),
        },
      }),
    );
    await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: endpointWithoutDlq.arn,
      }),
    );

    await sqs.send(new DeleteQueueCommand({ QueueUrl: endpointWithDlq.url }));
    await sqs.send(new DeleteQueueCommand({ QueueUrl: endpointWithoutDlq.url }));

    await sns.send(new PublishCommand({ TopicArn: topic.TopicArn!, Message: "mixed" }));

    const inDlq = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlq.url, MaxNumberOfMessages: 5 }),
    );
    expect(inDlq.Messages ?? []).toHaveLength(1);
  });

  it("routes PublishBatch deliveries to the subscription DLQ", async () => {
    const topic = await sns.send(new CreateTopicCommand({ Name: "sub-dlq-batch" }));
    const endpoint = await createQueueWithArn(sqs, "sub-dlq-batch-endpoint");
    const dlq = await createQueueWithArn(sqs, "sub-dlq-batch-dlq");

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
    await sqs.send(new DeleteQueueCommand({ QueueUrl: endpoint.url }));

    await sns.send(
      new PublishBatchCommand({
        TopicArn: topic.TopicArn!,
        PublishBatchRequestEntries: [
          { Id: "1", Message: "batch-1" },
          { Id: "2", Message: "batch-2" },
        ],
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlq.url, MaxNumberOfMessages: 10 }),
    );
    expect(received.Messages ?? []).toHaveLength(2);
    const bodies = received
      .Messages!.map((m) => JSON.parse(m.Body!).Message)
      .sort();
    expect(bodies).toEqual(["batch-1", "batch-2"]);
  });

  it("routes FIFO topic deliveries to a FIFO DLQ with sequence numbers", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({
        Name: `sub-dlq-fifo-${Date.now()}.fifo`,
        Attributes: { FifoTopic: "true", ContentBasedDeduplication: "true" },
      }),
    );
    const endpoint = await createQueueWithArn(
      sqs,
      `sub-dlq-fifo-endpoint-${Date.now()}.fifo`,
      { FifoQueue: "true", ContentBasedDeduplication: "true" },
    );
    const dlq = await createQueueWithArn(
      sqs,
      `sub-dlq-fifo-dlq-${Date.now()}.fifo`,
      { FifoQueue: "true", ContentBasedDeduplication: "true" },
    );

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
    await sqs.send(new DeleteQueueCommand({ QueueUrl: endpoint.url }));

    await sns.send(
      new PublishCommand({
        TopicArn: topic.TopicArn!,
        Message: "fifo-1",
        MessageGroupId: "g1",
      }),
    );
    await sns.send(
      new PublishCommand({
        TopicArn: topic.TopicArn!,
        Message: "fifo-2",
        MessageGroupId: "g1",
      }),
    );

    // FIFO receive locks the message group until ack — drain in two calls,
    // deleting between them.
    const first = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: dlq.url,
        MaxNumberOfMessages: 10,
        AttributeNames: ["All"],
      }),
    );
    expect(first.Messages).toHaveLength(1);
    expect(JSON.parse(first.Messages![0].Body!).Message).toBe("fifo-1");
    expect(first.Messages![0].Attributes?.SequenceNumber).toBeDefined();

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: dlq.url,
        ReceiptHandle: first.Messages![0].ReceiptHandle!,
      }),
    );

    const second = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: dlq.url,
        MaxNumberOfMessages: 10,
        AttributeNames: ["All"],
      }),
    );
    expect(second.Messages).toHaveLength(1);
    expect(JSON.parse(second.Messages![0].Body!).Message).toBe("fifo-2");
    expect(second.Messages![0].Attributes?.SequenceNumber).toBeDefined();
  });

  it("routes FIFO topic deliveries to a non-FIFO DLQ", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({
        Name: `sub-dlq-fifo-nonfifo-${Date.now()}.fifo`,
        Attributes: { FifoTopic: "true", ContentBasedDeduplication: "true" },
      }),
    );
    const endpoint = await createQueueWithArn(
      sqs,
      `sub-dlq-fifo-nonfifo-endpoint-${Date.now()}.fifo`,
      { FifoQueue: "true", ContentBasedDeduplication: "true" },
    );
    // Non-FIFO DLQ — supported per AWS, useful when the operator wants a
    // simple sink without ordering guarantees.
    const dlq = await createQueueWithArn(sqs, `sub-dlq-fifo-nonfifo-dlq-${Date.now()}`);

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
    await sqs.send(new DeleteQueueCommand({ QueueUrl: endpoint.url }));

    await sns.send(
      new PublishCommand({
        TopicArn: topic.TopicArn!,
        Message: "fifo-to-standard",
        MessageGroupId: "g1",
      }),
    );

    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlq.url, MaxNumberOfMessages: 1 }),
    );
    expect(received.Messages).toHaveLength(1);
    expect(JSON.parse(received.Messages![0].Body!).Message).toBe("fifo-to-standard");
  });

  it("rejects malformed RedrivePolicy at SetSubscriptionAttributes", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "sub-dlq-malformed-set" }),
    );
    const endpoint = await createQueueWithArn(sqs, "sub-dlq-malformed-set-endpoint");

    const sub = await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: endpoint.arn,
      }),
    );

    await expect(
      sns.send(
        new SetSubscriptionAttributesCommand({
          SubscriptionArn: sub.SubscriptionArn!,
          AttributeName: "RedrivePolicy",
          AttributeValue: "not json",
        }),
      ),
    ).rejects.toThrow(/RedrivePolicy/);

    await expect(
      sns.send(
        new SetSubscriptionAttributesCommand({
          SubscriptionArn: sub.SubscriptionArn!,
          AttributeName: "RedrivePolicy",
          AttributeValue: JSON.stringify({ deadLetterTargetArn: 42 }),
        }),
      ),
    ).rejects.toThrow(/RedrivePolicy/);

    await expect(
      sns.send(
        new SetSubscriptionAttributesCommand({
          SubscriptionArn: sub.SubscriptionArn!,
          AttributeName: "RedrivePolicy",
          AttributeValue: "[1, 2, 3]",
        }),
      ),
    ).rejects.toThrow(/RedrivePolicy/);
  });

  it("rejects malformed RedrivePolicy at Subscribe", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "sub-dlq-malformed-subscribe" }),
    );
    const endpoint = await createQueueWithArn(
      sqs,
      "sub-dlq-malformed-subscribe-endpoint",
    );

    await expect(
      sns.send(
        new SubscribeCommand({
          TopicArn: topic.TopicArn!,
          Protocol: "sqs",
          Endpoint: endpoint.arn,
          Attributes: { RedrivePolicy: "not json" },
        }),
      ),
    ).rejects.toThrow(/RedrivePolicy/);
  });

  it("still accepts an empty-object RedrivePolicy (no effective DLQ)", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "sub-dlq-empty-policy" }),
    );
    const endpoint = await createQueueWithArn(sqs, "sub-dlq-empty-policy-endpoint");

    const sub = await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: endpoint.arn,
        Attributes: { RedrivePolicy: "{}" },
      }),
    );
    expect(sub.SubscriptionArn).toBeDefined();

    // Empty policy followed by missing endpoint should silently drop, not throw.
    await sqs.send(new DeleteQueueCommand({ QueueUrl: endpoint.url }));
    await expect(
      sns.send(new PublishCommand({ TopicArn: topic.TopicArn!, Message: "x" })),
    ).resolves.toBeDefined();
  });
});
