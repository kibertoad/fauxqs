import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GetSubscriptionAttributesCommand,
  GetTopicAttributesCommand,
  ListSubscriptionsByTopicCommand,
  ListTagsForResourceCommand,
  PublishCommand,
  SetSubscriptionAttributesCommand,
} from "@aws-sdk/client-sns";
import { startFauxqs, type FauxqsInitConfig, type FauxqsServer } from "../../src/app.js";
import { createSnsClient } from "../helpers/clients.js";

const TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:drift-topic";

function initWith(overrides: {
  subscriptionAttributes?: Record<string, string>;
  topicAttributes?: Record<string, string>;
  topicTags?: Record<string, string>;
}): FauxqsInitConfig {
  return {
    queues: [{ name: "drift-queue" }],
    topics: [
      { name: "drift-topic", attributes: overrides.topicAttributes, tags: overrides.topicTags },
    ],
    subscriptions: [
      { topic: "drift-topic", queue: "drift-queue", attributes: overrides.subscriptionAttributes },
    ],
  };
}

function filterOn(eventType: string): string {
  return JSON.stringify({ eventType: [eventType] });
}

describe("init config applied over persisted state", () => {
  let dataDir: string;
  let server: FauxqsServer | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "fauxqs-test-"));
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    // On Windows, SQLite WAL/SHM files may briefly remain locked after close.
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  async function restartWith(init: FauxqsInitConfig): Promise<FauxqsServer> {
    await server?.stop();
    server = await startFauxqs({ port: 0, logger: false, dataDir, init });
    return server;
  }

  async function subscriptionAttributes(port: number): Promise<Record<string, string>> {
    const sns = createSnsClient(port);
    try {
      const { Subscriptions } = await sns.send(
        new ListSubscriptionsByTopicCommand({ TopicArn: TOPIC_ARN }),
      );
      expect(Subscriptions).toHaveLength(1);
      const { Attributes } = await sns.send(
        new GetSubscriptionAttributesCommand({
          SubscriptionArn: Subscriptions![0].SubscriptionArn,
        }),
      );
      return Attributes ?? {};
    } finally {
      sns.destroy();
    }
  }

  it("starts and applies changed subscription attributes", async () => {
    await restartWith(
      initWith({
        subscriptionAttributes: { FilterPolicy: filterOn("old"), RawMessageDelivery: "true" },
      }),
    );

    const { port } = await restartWith(
      initWith({ subscriptionAttributes: { FilterPolicy: filterOn("new") } }),
    );

    const attributes = await subscriptionAttributes(port);
    expect(attributes.FilterPolicy).toBe(filterOn("new"));
    expect(attributes.RawMessageDelivery).toBe("true");
  });

  it("keeps subscription attributes set at runtime that the config does not list", async () => {
    const first = await restartWith(
      initWith({ subscriptionAttributes: { FilterPolicy: filterOn("old") } }),
    );
    const sns = createSnsClient(first.port);
    try {
      const { Subscriptions } = await sns.send(
        new ListSubscriptionsByTopicCommand({ TopicArn: TOPIC_ARN }),
      );
      await sns.send(
        new SetSubscriptionAttributesCommand({
          SubscriptionArn: Subscriptions![0].SubscriptionArn,
          AttributeName: "RawMessageDelivery",
          AttributeValue: "true",
        }),
      );
    } finally {
      sns.destroy();
    }

    const { port } = await restartWith(
      initWith({ subscriptionAttributes: { FilterPolicy: filterOn("old") } }),
    );

    const attributes = await subscriptionAttributes(port);
    expect(attributes.RawMessageDelivery).toBe("true");
  });

  it("rejects the same subscription listed twice with different attributes", async () => {
    const config = initWith({ subscriptionAttributes: { FilterPolicy: filterOn("old") } });
    config.subscriptions!.push({
      topic: "drift-topic",
      queue: "drift-queue",
      attributes: { FilterPolicy: filterOn("new") },
    });

    await expect(restartWith(config)).rejects.toThrow(/listed twice with different attributes/);
  });

  it("routes by the new filter policy, not the cached old one", async () => {
    await restartWith(initWith({ subscriptionAttributes: { FilterPolicy: filterOn("old") } }));
    const { port } = await restartWith(
      initWith({ subscriptionAttributes: { FilterPolicy: filterOn("new") } }),
    );

    const sns = createSnsClient(port);
    try {
      for (const eventType of ["old", "new"]) {
        await sns.send(
          new PublishCommand({
            TopicArn: TOPIC_ARN,
            Message: eventType,
            MessageAttributes: { eventType: { DataType: "String", StringValue: eventType } },
          }),
        );
      }
    } finally {
      sns.destroy();
    }

    const bodies = server!
      .inspectQueue("drift-queue")!
      .messages.ready.map((m) => JSON.parse(m.body).Message);
    expect(bodies).toEqual(["new"]);
  });

  it("keeps the updated attributes across a further restart", async () => {
    await restartWith(initWith({ subscriptionAttributes: { FilterPolicy: filterOn("old") } }));
    await restartWith(initWith({ subscriptionAttributes: { FilterPolicy: filterOn("new") } }));

    // Without init, only the persisted state is loaded.
    await server!.stop();
    server = await startFauxqs({ port: 0, logger: false, dataDir });

    const attributes = await subscriptionAttributes(server.port);
    expect(attributes.FilterPolicy).toBe(filterOn("new"));
  });

  it("starts and applies changed topic attributes and tags", async () => {
    await restartWith(
      initWith({ topicAttributes: { DisplayName: "old" }, topicTags: { team: "old" } }),
    );
    const { port } = await restartWith(
      initWith({ topicAttributes: { DisplayName: "new" }, topicTags: { team: "new" } }),
    );

    const sns = createSnsClient(port);
    try {
      const { Attributes } = await sns.send(
        new GetTopicAttributesCommand({ TopicArn: TOPIC_ARN }),
      );
      expect(Attributes?.DisplayName).toBe("new");
      const { Tags } = await sns.send(new ListTagsForResourceCommand({ ResourceArn: TOPIC_ARN }));
      expect(Tags).toEqual([{ Key: "team", Value: "new" }]);
    } finally {
      sns.destroy();
    }
  });

  it("reports which existing resources it updated", async () => {
    const first = await restartWith(
      initWith({ subscriptionAttributes: { FilterPolicy: filterOn("old") } }),
    );
    const unchanged = first.setup(
      initWith({ subscriptionAttributes: { FilterPolicy: filterOn("old") } }),
    );
    expect(unchanged.topics[0]).toMatchObject({ created: false, updated: false });
    expect(unchanged.subscriptions[0]).toMatchObject({ created: false, updated: false });

    const changed = first.setup(
      initWith({
        subscriptionAttributes: { FilterPolicy: filterOn("new") },
        topicAttributes: { DisplayName: "new" },
      }),
    );
    expect(changed.topics[0]).toMatchObject({ created: false, updated: true });
    expect(changed.subscriptions[0]).toMatchObject({ created: false, updated: true });
  });
});
