import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateTopicCommand,
  DeleteTopicCommand,
  ListTopicsCommand,
  GetTopicAttributesCommand,
  SetTopicAttributesCommand,
} from "@aws-sdk/client-sns";
import { createSnsClient } from "../helpers/clients.js";
import { createTestServer, type TestServer } from "../helpers/setup.js";

describe("SNS Topic Management", () => {
  let server: TestServer;
  let sns: ReturnType<typeof createSnsClient>;

  beforeAll(async () => {
    server = await createTestServer();
    sns = createSnsClient(server.port);
  });

  afterAll(async () => {
    sns.destroy();
    await server.app.close();
  });

  it("creates a topic and returns its ARN", async () => {
    const result = await sns.send(
      new CreateTopicCommand({ Name: "test-topic" }),
    );
    expect(result.TopicArn).toContain("test-topic");
    expect(result.TopicArn).toMatch(/^arn:aws:sns:us-east-1:000000000000:test-topic$/);
  });

  it("is idempotent for same name", async () => {
    const result1 = await sns.send(
      new CreateTopicCommand({ Name: "idem-topic" }),
    );
    const result2 = await sns.send(
      new CreateTopicCommand({ Name: "idem-topic" }),
    );
    expect(result1.TopicArn).toBe(result2.TopicArn);
  });

  it("lists topics", async () => {
    await sns.send(new CreateTopicCommand({ Name: "list-a" }));
    await sns.send(new CreateTopicCommand({ Name: "list-b" }));

    const result = await sns.send(new ListTopicsCommand({}));
    const arns = result.Topics?.map((t) => t.TopicArn) ?? [];
    expect(arns.some((a) => a?.includes("list-a"))).toBe(true);
    expect(arns.some((a) => a?.includes("list-b"))).toBe(true);
  });

  it("gets topic attributes", async () => {
    const created = await sns.send(
      new CreateTopicCommand({ Name: "attr-topic" }),
    );

    const result = await sns.send(
      new GetTopicAttributesCommand({ TopicArn: created.TopicArn! }),
    );

    expect(result.Attributes?.TopicArn).toBe(created.TopicArn);
  });

  it("sets topic attributes", async () => {
    const created = await sns.send(
      new CreateTopicCommand({ Name: "set-attr-topic" }),
    );

    await sns.send(
      new SetTopicAttributesCommand({
        TopicArn: created.TopicArn!,
        AttributeName: "DisplayName",
        AttributeValue: "My Display Name",
      }),
    );

    const result = await sns.send(
      new GetTopicAttributesCommand({ TopicArn: created.TopicArn! }),
    );
    expect(result.Attributes?.DisplayName).toBe("My Display Name");
  });

  it("deletes a topic", async () => {
    const created = await sns.send(
      new CreateTopicCommand({ Name: "delete-topic" }),
    );

    await sns.send(
      new DeleteTopicCommand({ TopicArn: created.TopicArn! }),
    );

    const list = await sns.send(new ListTopicsCommand({}));
    const arns = list.Topics?.map((t) => t.TopicArn) ?? [];
    expect(arns.includes(created.TopicArn!)).toBe(false);
  });
});
