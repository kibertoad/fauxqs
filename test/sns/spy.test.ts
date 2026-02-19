import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import {
  CreateTopicCommand,
  SubscribeCommand,
  PublishCommand,
  PublishBatchCommand,
  SetSubscriptionAttributesCommand,
} from "@aws-sdk/client-sns";
import { createSqsClient, createSnsClient } from "../helpers/clients.js";
import { startFauxqs, type FauxqsServer, type SnsSpyMessage } from "../../src/app.js";

describe("MessageSpy - SNS", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;
  let sns: ReturnType<typeof createSnsClient>;

  beforeAll(async () => {
    server = await startFauxqs({ port: 0, logger: false, messageSpies: true });
    sqs = createSqsClient(server.port);
    sns = createSnsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    sns.destroy();
    await server.stop();
  });

  it("tracks SNS Publish events", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "sns-spy-publish" }),
    );

    await sns.send(
      new PublishCommand({
        TopicArn: topic.TopicArn!,
        Message: "sns spy test",
      }),
    );

    const msg = server.spy.checkForMessage(
      { service: "sns", topicName: "sns-spy-publish", status: "published" },
    );
    expect(msg).toBeDefined();
    expect(msg!.service).toBe("sns");
    expect((msg as SnsSpyMessage).body).toBe("sns spy test");
    expect((msg as SnsSpyMessage).topicArn).toBe(topic.TopicArn!);
  });

  it("tracks SNS PublishBatch events — one per entry", async () => {
    server.spy.clear();

    const topic = await sns.send(
      new CreateTopicCommand({ Name: "sns-spy-batch" }),
    );

    await sns.send(
      new PublishBatchCommand({
        TopicArn: topic.TopicArn!,
        PublishBatchRequestEntries: [
          { Id: "a", Message: "batch-a" },
          { Id: "b", Message: "batch-b" },
          { Id: "c", Message: "batch-c" },
        ],
      }),
    );

    const all = server.spy.getAllMessages().filter(
      (m) => m.service === "sns" && (m as SnsSpyMessage).topicName === "sns-spy-batch",
    );
    expect(all).toHaveLength(3);
    const bodies = all.map((m) => (m as SnsSpyMessage).body).sort();
    expect(bodies).toEqual(["batch-a", "batch-b", "batch-c"]);
  });

  it("resolves retroactively when SNS message already in buffer", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "sns-spy-retro" }),
    );

    await sns.send(
      new PublishCommand({
        TopicArn: topic.TopicArn!,
        Message: "retro sns",
      }),
    );

    // Message already in buffer — should resolve immediately
    const msg = await server.spy.waitForMessage(
      (m) => m.service === "sns" && (m as SnsSpyMessage).body === "retro sns",
      "published",
    );
    expect(msg.service).toBe("sns");
    expect((msg as SnsSpyMessage).topicName).toBe("sns-spy-retro");
  });

  it("resolves in the future when SNS message has not arrived yet", async () => {
    const topic = await sns.send(
      new CreateTopicCommand({ Name: "sns-spy-future" }),
    );

    // Start waiting before the message is sent
    const promise = server.spy.waitForMessage(
      (m) => m.service === "sns" && (m as SnsSpyMessage).topicName === "sns-spy-future" && (m as SnsSpyMessage).body === "future sns",
      "published",
    );

    await new Promise((r) => setTimeout(r, 50));

    await sns.send(
      new PublishCommand({
        TopicArn: topic.TopicArn!,
        Message: "future sns",
      }),
    );

    const msg = await promise;
    expect(msg.service).toBe("sns");
    expect((msg as SnsSpyMessage).body).toBe("future sns");
  });

  it("SNS publish also triggers SQS published events on subscribed queues", async () => {
    server.spy.clear();

    const topic = await sns.send(
      new CreateTopicCommand({ Name: "sns-spy-fanout" }),
    );
    const queue = await sqs.send(
      new CreateQueueCommand({ QueueName: "sns-spy-fanout-q" }),
    );
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );

    const sub = await sns.send(
      new SubscribeCommand({
        TopicArn: topic.TopicArn!,
        Protocol: "sqs",
        Endpoint: attrs.Attributes!.QueueArn!,
      }),
    );
    await sns.send(
      new SetSubscriptionAttributesCommand({
        SubscriptionArn: sub.SubscriptionArn!,
        AttributeName: "RawMessageDelivery",
        AttributeValue: "true",
      }),
    );

    await sns.send(
      new PublishCommand({
        TopicArn: topic.TopicArn!,
        Message: "fanout msg",
      }),
    );

    // Should see SNS published event
    const snsMsg = server.spy.checkForMessage(
      { service: "sns", topicName: "sns-spy-fanout", status: "published" },
    );
    expect(snsMsg).toBeDefined();

    // Should also see SQS published event on the queue
    const sqsMsg = server.spy.checkForMessage(
      (m) => m.service === "sqs" && m.status === "published" && "queueName" in m && m.queueName === "sns-spy-fanout-q",
    );
    expect(sqsMsg).toBeDefined();
  });
});
