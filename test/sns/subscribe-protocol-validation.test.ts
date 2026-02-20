import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateTopicCommand,
  SubscribeCommand,
} from "@aws-sdk/client-sns";
import { createSnsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SNS Subscribe protocol validation", () => {
  let server: FauxqsServer;
  let sns: ReturnType<typeof createSnsClient>;
  let topicArn: string;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sns = createSnsClient(server.port);
    const result = await sns.send(
      new CreateTopicCommand({ Name: "proto-validation-topic" }),
    );
    topicArn = result.TopicArn!;
  });

  afterAll(async () => {
    sns.destroy();
    await server.stop();
  });

  it("accepts all valid protocols", async () => {
    const validProtocols = [
      "http", "https", "email", "email-json",
      "sms", "sqs", "application", "lambda", "firehose",
    ];

    for (const protocol of validProtocols) {
      const result = await sns.send(
        new SubscribeCommand({
          TopicArn: topicArn,
          Protocol: protocol,
          Endpoint: `arn:aws:sqs:us-east-1:000000000000:queue-for-${protocol}`,
        }),
      );
      expect(result.SubscriptionArn).toBeDefined();
    }
  });

  it("rejects invalid protocol", async () => {
    await expect(
      sns.send(
        new SubscribeCommand({
          TopicArn: topicArn,
          Protocol: "ftp",
          Endpoint: "ftp://example.com",
        }),
      ),
    ).rejects.toThrow("Invalid parameter");
  });

  it("rejects empty-ish protocol", async () => {
    await expect(
      sns.send(
        new SubscribeCommand({
          TopicArn: topicArn,
          Protocol: "websocket",
          Endpoint: "ws://example.com",
        }),
      ),
    ).rejects.toThrow("Invalid parameter");
  });
});
