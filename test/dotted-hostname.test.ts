import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SNSClient, CreateTopicCommand, ListTopicsCommand } from "@aws-sdk/client-sns";
import { SQSClient, CreateQueueCommand, ListQueuesCommand } from "@aws-sdk/client-sqs";
import { startFauxqsTestServer, type FauxqsServer } from "./helpers/setup.js";

/**
 * When the AWS endpoint contains dots (e.g. localhost.fauxqs.dev),
 * the rewriteUrl hook must not misinterpret the hostname as an S3
 * virtual-hosted-style bucket request. SNS and SQS requests should
 * still route correctly to POST /.
 */
describe("SNS/SQS with dotted hostname", () => {
  let server: FauxqsServer;
  let sns: SNSClient;
  let sqs: SQSClient;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sns = new SNSClient({
      region: "us-east-1",
      endpoint: `http://localhost.fauxqs.dev:${server.port}`,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    sqs = new SQSClient({
      region: "us-east-1",
      endpoint: `http://localhost.fauxqs.dev:${server.port}`,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
  });

  afterAll(async () => {
    sns.destroy();
    sqs.destroy();
    await server.stop();
  });

  it("SNS CreateTopic returns TopicArn", async () => {
    const result = await sns.send(new CreateTopicCommand({ Name: "dotted-host-topic" }));
    expect(result.TopicArn).toContain("dotted-host-topic");
  });

  it("SNS ListTopics works", async () => {
    await sns.send(new CreateTopicCommand({ Name: "dotted-list-topic" }));
    const result = await sns.send(new ListTopicsCommand({}));
    const arns = result.Topics?.map((t) => t.TopicArn) ?? [];
    expect(arns.some((a) => a?.includes("dotted-list-topic"))).toBe(true);
  });

  it("SQS CreateQueue returns QueueUrl", async () => {
    const result = await sqs.send(new CreateQueueCommand({ QueueName: "dotted-host-queue" }));
    expect(result.QueueUrl).toContain("dotted-host-queue");
  });

  it("SQS ListQueues works", async () => {
    await sqs.send(new CreateQueueCommand({ QueueName: "dotted-list-queue" }));
    const result = await sqs.send(new ListQueuesCommand({}));
    const urls = result.QueueUrls ?? [];
    expect(urls.some((u) => u.includes("dotted-list-queue"))).toBe(true);
  });
});
