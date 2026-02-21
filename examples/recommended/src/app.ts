/**
 * A simple Fastify app that stores files in S3, sends SQS notifications,
 * and publishes events to SNS topics.
 *
 * This is the "application under test" — the same code runs in both
 * library-mode tests and Docker-based acceptance tests. The only difference
 * is where the AWS endpoint points to.
 */
import Fastify from "fastify";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

export interface AppConfig {
  awsEndpoint: string;
  s3Endpoint: string;
  bucket: string;
  queueUrl: string;
  topicArn: string;
  region?: string;
}

export function buildApp(config: AppConfig) {
  const { awsEndpoint, s3Endpoint, bucket, queueUrl, topicArn, region = "us-east-1" } = config;
  const credentials = { accessKeyId: "test", secretAccessKey: "test" };

  // S3 uses a separate endpoint (e.g., http://s3.localhost:PORT) so that
  // virtual-hosted-style requests work without forcePathStyle.
  // In tests, interceptLocalhostDns() in the vitest setupFile resolves *.localhost → 127.0.0.1.
  // In Docker, the built-in dnsmasq resolves *.s3.fauxqs to the container IP.
  const s3 = new S3Client({ endpoint: s3Endpoint, region, credentials });
  const sqs = new SQSClient({ endpoint: awsEndpoint, region, credentials });
  const sns = new SNSClient({ endpoint: awsEndpoint, region, credentials });

  const app = Fastify({ logger: false });

  // Upload a file to S3, send direct SQS notification, and publish SNS event
  app.post<{ Params: { key: string }; Body: { content: string; contentType?: string } }>(
    "/files/:key",
    async (request, reply) => {
      const { key } = request.params;
      const { content, contentType } = request.body;

      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: content,
        ContentType: contentType ?? "text/plain",
      }));

      // Direct SQS notification
      await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          event: "file.uploaded",
          key,
          bucket,
          size: content.length,
        }),
      }));

      // SNS event (fans out to all subscribed queues)
      await sns.send(new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify({ event: "file.uploaded", key, bucket }),
        MessageAttributes: {
          eventType: { DataType: "String", StringValue: "file.uploaded" },
          fileExtension: { DataType: "String", StringValue: key.split(".").pop() ?? "" },
        },
      }));

      return reply.code(201).send({ key, bucket });
    },
  );

  // Download a file from S3
  app.get<{ Params: { key: string } }>("/files/:key", async (request, reply) => {
    const { key } = request.params;
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await result.Body?.transformToString();

    return reply
      .header("content-type", result.ContentType ?? "text/plain")
      .send(body);
  });

  return app;
}
