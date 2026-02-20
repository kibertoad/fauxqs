import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CreateTopicCommand } from "@aws-sdk/client-sns";
import { createSnsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SNS CreateTopic attribute idempotency", () => {
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

  it("succeeds when second call provides a subset of existing attributes", async () => {
    await sns.send(
      new CreateTopicCommand({
        Name: "bidir-extra-attrs",
        Attributes: { DisplayName: "Original", KmsMasterKeyId: "key-123" },
      }),
    );

    // Second call provides only DisplayName — existing has KmsMasterKeyId too, but that's fine.
    // AWS only checks attributes present in the request, not the other direction.
    const result = await sns.send(
      new CreateTopicCommand({
        Name: "bidir-extra-attrs",
        Attributes: { DisplayName: "Original" },
      }),
    );
    expect(result.TopicArn).toContain("bidir-extra-attrs");
  });

  it("succeeds when both calls have identical attributes", async () => {
    await sns.send(
      new CreateTopicCommand({
        Name: "bidir-same-attrs",
        Attributes: { DisplayName: "Same" },
      }),
    );

    const result = await sns.send(
      new CreateTopicCommand({
        Name: "bidir-same-attrs",
        Attributes: { DisplayName: "Same" },
      }),
    );

    expect(result.TopicArn).toContain("bidir-same-attrs");
  });

  it("throws when new request has attributes that conflict with existing values", async () => {
    await sns.send(
      new CreateTopicCommand({ Name: "bidir-no-attrs" }),
    );

    // Existing topic has no DisplayName, so providing one conflicts
    await expect(
      sns.send(
        new CreateTopicCommand({
          Name: "bidir-no-attrs",
          Attributes: { DisplayName: "New" },
        }),
      ),
    ).rejects.toThrow("Topic already exists with different attributes");
  });

  it("returns existing topic when second call omits attributes entirely", async () => {
    const result1 = await sns.send(
      new CreateTopicCommand({
        Name: "bidir-omit-attrs",
        Attributes: { DisplayName: "WithAttrs" },
      }),
    );

    // Omitting attributes (undefined) means "don't check" — should return existing
    const result2 = await sns.send(
      new CreateTopicCommand({ Name: "bidir-omit-attrs" }),
    );

    expect(result1.TopicArn).toBe(result2.TopicArn);
  });
});
