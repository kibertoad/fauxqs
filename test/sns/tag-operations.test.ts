import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateTopicCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ListTagsForResourceCommand,
} from "@aws-sdk/client-sns";
import { createSnsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SNS Tag Operations", () => {
  let server: FauxqsServer;
  let sns: ReturnType<typeof createSnsClient>;
  let topicArn: string;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sns = createSnsClient(server.port);
    const result = await sns.send(new CreateTopicCommand({ Name: "tag-test-topic" }));
    topicArn = result.TopicArn!;
  });

  afterAll(async () => {
    sns.destroy();
    await server.stop();
  });

  it("tags a topic and lists the tags", async () => {
    await sns.send(
      new TagResourceCommand({
        ResourceArn: topicArn,
        Tags: [
          { Key: "env", Value: "test" },
          { Key: "team", Value: "platform" },
        ],
      }),
    );

    const result = await sns.send(
      new ListTagsForResourceCommand({ ResourceArn: topicArn }),
    );

    expect(result.Tags).toHaveLength(2);
    expect(result.Tags).toContainEqual({ Key: "env", Value: "test" });
    expect(result.Tags).toContainEqual({ Key: "team", Value: "platform" });
  });

  it("overwrites existing tag value", async () => {
    await sns.send(
      new TagResourceCommand({
        ResourceArn: topicArn,
        Tags: [{ Key: "env", Value: "production" }],
      }),
    );

    const result = await sns.send(
      new ListTagsForResourceCommand({ ResourceArn: topicArn }),
    );

    const envTag = result.Tags!.find((t) => t.Key === "env");
    expect(envTag?.Value).toBe("production");
  });

  it("untags a topic", async () => {
    await sns.send(
      new UntagResourceCommand({
        ResourceArn: topicArn,
        TagKeys: ["team"],
      }),
    );

    const result = await sns.send(
      new ListTagsForResourceCommand({ ResourceArn: topicArn }),
    );

    expect(result.Tags!.find((t) => t.Key === "team")).toBeUndefined();
    expect(result.Tags!.find((t) => t.Key === "env")).toBeDefined();
  });

  it("returns empty tags for topic with no tags", async () => {
    const created = await sns.send(new CreateTopicCommand({ Name: "no-tags-topic" }));

    const result = await sns.send(
      new ListTagsForResourceCommand({ ResourceArn: created.TopicArn! }),
    );

    expect(result.Tags).toEqual([]);
  });
});
