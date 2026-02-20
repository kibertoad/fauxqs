import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateTopicCommand,
  SetTopicAttributesCommand,
} from "@aws-sdk/client-sns";
import { createSnsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SNS SetTopicAttributes attribute name validation", () => {
  let server: FauxqsServer;
  let sns: ReturnType<typeof createSnsClient>;
  let topicArn: string;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sns = createSnsClient(server.port);
    const result = await sns.send(
      new CreateTopicCommand({ Name: "set-attr-validation-topic" }),
    );
    topicArn = result.TopicArn!;
  });

  afterAll(async () => {
    sns.destroy();
    await server.stop();
  });

  it("accepts valid attribute names", async () => {
    for (const name of [
      "DisplayName",
      "Policy",
      "DeliveryPolicy",
      "KmsMasterKeyId",
      "KmsDataKeyReusePeriodSeconds",
      "TracingConfig",
      "SignatureVersion",
      "ContentBasedDeduplication",
    ]) {
      await expect(
        sns.send(
          new SetTopicAttributesCommand({
            TopicArn: topicArn,
            AttributeName: name,
            AttributeValue: "test-value",
          }),
        ),
      ).resolves.toBeDefined();
    }
  });

  it("rejects invalid attribute name", async () => {
    await expect(
      sns.send(
        new SetTopicAttributesCommand({
          TopicArn: topicArn,
          AttributeName: "NotARealAttribute",
          AttributeValue: "value",
        }),
      ),
    ).rejects.toThrow("Invalid parameter");
  });

  it("rejects TopicArn as an attribute name", async () => {
    await expect(
      sns.send(
        new SetTopicAttributesCommand({
          TopicArn: topicArn,
          AttributeName: "TopicArn",
          AttributeValue: "arn:fake",
        }),
      ),
    ).rejects.toThrow("Invalid parameter");
  });
});
