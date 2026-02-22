import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CreateTopicCommand } from "@aws-sdk/client-sns";
import { createSnsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SNS Create Topic Name Validation", () => {
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

  it("rejects topic name longer than 256 characters", async () => {
    await expect(
      sns.send(new CreateTopicCommand({ Name: "a".repeat(257) })),
    ).rejects.toThrow(/too long/i);
  });

  it("rejects topic name with invalid characters (spaces)", async () => {
    await expect(
      sns.send(new CreateTopicCommand({ Name: "invalid topic name" })),
    ).rejects.toThrow(/alphanumeric|invalid/i);
  });

  it("rejects topic name with dots (non-FIFO)", async () => {
    await expect(
      sns.send(new CreateTopicCommand({ Name: "invalid.name" })),
    ).rejects.toThrow(/alphanumeric|invalid/i);
  });

  it("accepts topic name with hyphens and underscores", async () => {
    const result = await sns.send(
      new CreateTopicCommand({ Name: "valid-topic_name" }),
    );
    expect(result.TopicArn).toBeDefined();
  });

  it("accepts FIFO topic with .fifo suffix", async () => {
    const result = await sns.send(
      new CreateTopicCommand({
        Name: "valid-fifo.fifo",
        Attributes: { FifoTopic: "true" },
      }),
    );
    expect(result.TopicArn).toContain("valid-fifo.fifo");
  });

  it("rejects FIFO topic name longer than 256 characters", async () => {
    await expect(
      sns.send(
        new CreateTopicCommand({ Name: "a".repeat(252) + ".fifo" }),
      ),
    ).rejects.toThrow(/too long/i);
  });
});
