/**
 * Docker — running fauxqs as a standalone Docker container.
 *
 * Start fauxqs:
 *   docker run -p 4566:4566 kibertoad/fauxqs
 *
 * With init config (pre-create resources on startup):
 *   docker run -p 4566:4566 -e FAUXQS_INIT=/app/init.json -v ./init.json:/app/init.json kibertoad/fauxqs
 *
 * With custom region:
 *   docker run -p 4566:4566 -e FAUXQS_DEFAULT_REGION=eu-west-1 kibertoad/fauxqs
 */
import { SQSClient, CreateQueueCommand, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { SNSClient, CreateTopicCommand, SubscribeCommand, PublishCommand } from "@aws-sdk/client-sns";
import { S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

async function main() {
  // The endpoint matches the published port from `docker run -p 4566:4566`
  const endpoint = "http://localhost:4566";
  const credentials = { accessKeyId: "test", secretAccessKey: "test" };
  const region = "us-east-1";

  // --- Configure SDK clients ---

  const sqsClient = new SQSClient({ endpoint, region, credentials });
  const snsClient = new SNSClient({ endpoint, region, credentials });
  // forcePathStyle is the simplest option for local emulators.
  // Alternatives: fauxqs.dev wildcard DNS, interceptLocalhostDns(), createLocalhostHandler().
  // See the README "S3 URL styles" section for details.
  const s3Client = new S3Client({ endpoint, region, credentials, forcePathStyle: true });

  // --- SQS ---

  const createQueueResult = await sqsClient.send(new CreateQueueCommand({
    QueueName: "docker-queue",
  }));
  const queueUrl = createQueueResult.QueueUrl!;

  await sqsClient.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ event: "user.signup", userId: "u-123" }),
    MessageAttributes: {
      eventType: { DataType: "String", StringValue: "user.signup" },
    },
  }));

  const receiveResult = await sqsClient.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 5,
    MessageSystemAttributeNames: ["All"],
    MessageAttributeNames: ["All"],
  }));

  if (receiveResult.Messages?.[0]) {
    console.log("Received:", receiveResult.Messages[0].Body);
    await sqsClient.send(new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiveResult.Messages[0].ReceiptHandle!,
    }));
  }

  // --- SNS → SQS ---

  const topicResult = await snsClient.send(new CreateTopicCommand({
    Name: "docker-topic",
  }));

  await snsClient.send(new SubscribeCommand({
    TopicArn: topicResult.TopicArn!,
    Protocol: "sqs",
    Endpoint: "arn:aws:sqs:us-east-1:000000000000:docker-queue",
  }));

  await snsClient.send(new PublishCommand({
    TopicArn: topicResult.TopicArn!,
    Message: JSON.stringify({ alert: "new signup" }),
  }));

  // --- S3 ---

  await s3Client.send(new CreateBucketCommand({ Bucket: "docker-bucket" }));

  await s3Client.send(new PutObjectCommand({
    Bucket: "docker-bucket",
    Key: "uploads/avatar.png",
    Body: Buffer.from("fake-image-data"),
    ContentType: "image/png",
  }));

  const getResult = await s3Client.send(new GetObjectCommand({
    Bucket: "docker-bucket",
    Key: "uploads/avatar.png",
  }));
  console.log("S3 content type:", getResult.ContentType);

  // --- Health check ---

  const health = await fetch(`${endpoint}/health`);
  const healthBody = await health.json();
  console.log("Health:", healthBody); // { status: "ok" }

  // --- Queue inspection via HTTP ---

  const queuesResponse = await fetch(`${endpoint}/_fauxqs/queues`);
  const queues = await queuesResponse.json();
  console.log("Queues:", queues);
}

main().catch(console.error);
