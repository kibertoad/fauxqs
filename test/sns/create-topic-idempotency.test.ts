import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CreateTopicCommand } from "@aws-sdk/client-sns";
import { createSnsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SNS CreateTopic Idempotency with Attributes (3.11)", () => {
  let server: FauxqsServer;
  let sns: ReturnType<typeof createSnsClient>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sns = createSnsClient(server.port);
  });

  afterAll(async () => {
    sns.destroy();
    await server.stop();
  });

  it("returns existing topic when name and attributes match", async () => {
    const result1 = await sns.send(
      new CreateTopicCommand({
        Name: "idempotent-topic",
        Attributes: { DisplayName: "My Topic" },
      }),
    );
    const result2 = await sns.send(
      new CreateTopicCommand({
        Name: "idempotent-topic",
        Attributes: { DisplayName: "My Topic" },
      }),
    );
    expect(result1.TopicArn).toBe(result2.TopicArn);
  });

  it("returns existing topic when called without attributes on second call", async () => {
    const result1 = await sns.send(
      new CreateTopicCommand({
        Name: "no-attr-second",
        Attributes: { DisplayName: "Test" },
      }),
    );
    // No attributes on second call - should return existing
    const result2 = await sns.send(
      new CreateTopicCommand({
        Name: "no-attr-second",
      }),
    );
    expect(result1.TopicArn).toBe(result2.TopicArn);
  });

  it("throws when creating topic with same name but different attributes", async () => {
    await sns.send(
      new CreateTopicCommand({
        Name: "conflict-attr-topic",
        Attributes: { DisplayName: "Original" },
      }),
    );

    await expect(
      sns.send(
        new CreateTopicCommand({
          Name: "conflict-attr-topic",
          Attributes: { DisplayName: "Different" },
        }),
      ),
    ).rejects.toThrow("Topic already exists with different attributes");
  });

  it("throws when creating FIFO topic with different ContentBasedDeduplication", async () => {
    await sns.send(
      new CreateTopicCommand({
        Name: "fifo-attr-conflict.fifo",
        Attributes: { FifoTopic: "true", ContentBasedDeduplication: "false" },
      }),
    );

    await expect(
      sns.send(
        new CreateTopicCommand({
          Name: "fifo-attr-conflict.fifo",
          Attributes: { FifoTopic: "true", ContentBasedDeduplication: "true" },
        }),
      ),
    ).rejects.toThrow("Topic already exists with different attributes");
  });
});
