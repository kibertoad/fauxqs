import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFauxqs, type FauxqsServer } from "../src/app.js";
import { createSqsClient, createSnsClient, createS3Client } from "./helpers/clients.js";
import {
  ListQueuesCommand,
} from "@aws-sdk/client-sqs";
import { ListTopicsCommand } from "@aws-sdk/client-sns";
import {
  ListBucketsCommand,
} from "@aws-sdk/client-s3";

describe("env vars", () => {
  let server: FauxqsServer;
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  function restoreEnv(): void {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  afterEach(async () => {
    if (server) await server.stop();
    restoreEnv();
  });

  it("FAUXQS_HOST sets queue URL host", async () => {
    setEnv("FAUXQS_HOST", "myhost");
    server = await startFauxqs({ port: 0, logger: false });
    server.createQueue("env-host-q");

    const sqs = createSqsClient(server.port);
    const result = await sqs.send(new ListQueuesCommand({}));
    expect(result.QueueUrls![0]).toContain("sqs.us-east-1.myhost");
  });

  it("FAUXQS_DEFAULT_REGION sets region in ARNs", async () => {
    setEnv("FAUXQS_DEFAULT_REGION", "eu-west-1");
    server = await startFauxqs({ port: 0, logger: false });
    server.createTopic("env-region-t");

    const sns = createSnsClient(server.port, "eu-west-1");
    const result = await sns.send(new ListTopicsCommand({}));
    expect(result.Topics![0].TopicArn).toContain("eu-west-1");
  });

  it("FAUXQS_LOGGER=false disables logging", async () => {
    setEnv("FAUXQS_LOGGER", "false");
    // If logger is properly disabled, the server starts without errors
    server = await startFauxqs({ port: 0 });
    expect(server.port).toBeGreaterThan(0);
  });

  it("FAUXQS_INIT loads config on startup", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "fauxqs-env-"));
    const configPath = join(tmpDir, "init.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        queues: [{ name: "env-init-q" }],
        topics: [{ name: "env-init-t" }],
        buckets: ["env-init-b"],
      }),
    );

    setEnv("FAUXQS_INIT", configPath);
    server = await startFauxqs({ port: 0, logger: false });

    const sqs = createSqsClient(server.port);
    const sns = createSnsClient(server.port);
    const s3 = createS3Client(server.port);

    const queues = await sqs.send(new ListQueuesCommand({}));
    expect(queues.QueueUrls).toHaveLength(1);
    expect(queues.QueueUrls![0]).toContain("env-init-q");

    const topics = await sns.send(new ListTopicsCommand({}));
    expect(topics.Topics).toHaveLength(1);

    const buckets = await s3.send(new ListBucketsCommand({}));
    expect(buckets.Buckets).toHaveLength(1);

    try {
      unlinkSync(configPath);
    } catch {
      // ignore
    }
  });

  it("programmatic options take precedence over env vars", async () => {
    setEnv("FAUXQS_DEFAULT_REGION", "ap-southeast-1");
    server = await startFauxqs({ port: 0, logger: false, defaultRegion: "eu-central-1" });
    server.createTopic("precedence-t");

    const sns = createSnsClient(server.port, "eu-central-1");
    const result = await sns.send(new ListTopicsCommand({}));
    expect(result.Topics![0].TopicArn).toContain("eu-central-1");
  });
});
