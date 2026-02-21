/**
 * MessageSpy — track events flowing through SQS, SNS, and S3.
 * The spy captures events in a fixed-size buffer and supports both
 * retroactive lookups and future-awaiting via promises.
 */
import { startFauxqs } from "fauxqs";
import type {
  MessageSpyReader,
  SpyMessage,
  SqsSpyMessage,
  SnsSpyMessage,
  S3SpyEvent,
  MessageSpyParams,
} from "fauxqs";
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

async function main() {
  // Enable the spy with a custom buffer size (default is 100 messages)
  const spyParams: MessageSpyParams = { bufferSize: 500 };
  const server = await startFauxqs({
    port: 0,
    logger: false,
    messageSpies: spyParams, // or just `true` for defaults
  });

  const spy: MessageSpyReader = server.spy;

  const endpoint = `http://127.0.0.1:${server.port}`;
  const credentials = { accessKeyId: "test", secretAccessKey: "test" };
  const region = "us-east-1";

  const sqsClient = new SQSClient({ endpoint, region, credentials });
  const snsClient = new SNSClient({ endpoint, region, credentials });
  const s3Client = new S3Client({ endpoint, region, credentials, forcePathStyle: true });

  server.createQueue("spy-queue");
  server.createQueue("dlq-queue");
  server.createQueue("spy-queue-with-dlq", {
    attributes: {
      VisibilityTimeout: "0",
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: "arn:aws:sqs:us-east-1:000000000000:dlq-queue",
        maxReceiveCount: "1",
      }),
    },
  });
  server.createTopic("spy-topic");
  server.subscribe({ topic: "spy-topic", queue: "spy-queue" });
  server.createBucket("spy-bucket");

  const queueUrl = `http://sqs.us-east-1.127.0.0.1:${server.port}/000000000000/spy-queue`;

  // ---------------------------------------------------------------
  // waitForMessage — partial-object filter
  // ---------------------------------------------------------------

  // Start waiting BEFORE the action (future-awaiting)
  const publishedPromise = spy.waitForMessage(
    { service: "sqs", queueName: "spy-queue", status: "published" },
    undefined,
    5000, // timeout in ms — rejects if no match arrives in time
  );

  await sqsClient.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: "hello from spy",
  }));

  const published = await publishedPromise;
  // Narrow the discriminated union to access service-specific fields
  if (published.service === "sqs") {
    console.log("Published message ID:", published.messageId);
  }

  // ---------------------------------------------------------------
  // waitForMessage — predicate filter
  // ---------------------------------------------------------------

  const predicatePromise = spy.waitForMessage(
    (msg) => msg.service === "sqs" && msg.status === "published" && msg.body.includes("predicate"),
    undefined,
    5000,
  );

  await sqsClient.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: "hello predicate filter",
  }));

  await predicatePromise;

  // ---------------------------------------------------------------
  // waitForMessage — with status parameter
  // ---------------------------------------------------------------

  const sendResult = await sqsClient.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: "consume me",
  }));

  const recv = await sqsClient.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 1,
  }));

  if (recv.Messages?.[0]) {
    await sqsClient.send(new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: recv.Messages[0].ReceiptHandle!,
    }));
  }

  // Wait for the "consumed" event by message ID
  const consumed = await spy.waitForMessageWithId(
    sendResult.MessageId!,
    "consumed",
    5000,
  );
  if (consumed.service === "sqs") {
    console.log("Consumed:", consumed.messageId);
  }

  // ---------------------------------------------------------------
  // waitForMessages — collect multiple matching events
  // ---------------------------------------------------------------

  spy.clear(); // Start with a clean buffer for this section

  for (let i = 0; i < 3; i++) {
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: `batch-${i}`,
    }));
  }

  const batchMessages = await spy.waitForMessages(
    { service: "sqs", queueName: "spy-queue", status: "published" },
    { count: 3, timeout: 5000 },
  );
  console.log(`Collected ${batchMessages.length} messages`);

  // ---------------------------------------------------------------
  // expectNoMessage — negative assertion
  // ---------------------------------------------------------------

  // Assert that no DLQ event arrives for this queue within 200ms
  await spy.expectNoMessage(
    { service: "sqs", queueName: "spy-queue" },
    { status: "dlq", within: 200 },
  );
  console.log("No DLQ message arrived (as expected)");

  // ---------------------------------------------------------------
  // checkForMessage — synchronous buffer lookup
  // ---------------------------------------------------------------

  const found = spy.checkForMessage(
    { service: "sqs", queueName: "spy-queue" },
    "published",
  );
  if (found && found.service === "sqs") {
    console.log("Found in buffer:", found.messageId);
  }

  // ---------------------------------------------------------------
  // getAllMessages + discriminated union narrowing
  // ---------------------------------------------------------------

  const allMessages: SpyMessage[] = spy.getAllMessages();
  console.log(`Buffer contains ${allMessages.length} events`);

  for (const msg of allMessages) {
    switch (msg.service) {
      case "sqs": {
        // TypeScript narrows to SqsSpyMessage
        const sqsMsg: SqsSpyMessage = msg;
        console.log(`SQS [${sqsMsg.status}] queue=${sqsMsg.queueName} id=${sqsMsg.messageId}`);
        break;
      }
      case "sns": {
        const snsMsg: SnsSpyMessage = msg;
        console.log(`SNS [${snsMsg.status}] topic=${snsMsg.topicName} id=${snsMsg.messageId}`);
        break;
      }
      case "s3": {
        const s3Evt: S3SpyEvent = msg;
        console.log(`S3 [${s3Evt.status}] bucket=${s3Evt.bucket} key=${s3Evt.key}`);
        break;
      }
    }
  }

  // ---------------------------------------------------------------
  // SNS spy events
  // ---------------------------------------------------------------

  const snsPublishedPromise = spy.waitForMessage(
    { service: "sns", topicName: "spy-topic" },
    "published",
    5000,
  );

  await snsClient.send(new PublishCommand({
    TopicArn: "arn:aws:sns:us-east-1:000000000000:spy-topic",
    Message: "sns event",
  }));

  const snsEvent = await snsPublishedPromise;
  if (snsEvent.service === "sns") {
    console.log("SNS spy:", snsEvent.topicArn);
  }

  // ---------------------------------------------------------------
  // S3 spy events
  // ---------------------------------------------------------------

  await s3Client.send(new PutObjectCommand({
    Bucket: "spy-bucket",
    Key: "test.txt",
    Body: Buffer.from("hello"),
  }));

  const uploadEvent = await spy.waitForMessage(
    { service: "s3", bucket: "spy-bucket", key: "test.txt", status: "uploaded" },
    undefined,
    5000,
  );
  console.log("S3 upload tracked:", uploadEvent.status);

  await s3Client.send(new GetObjectCommand({
    Bucket: "spy-bucket",
    Key: "test.txt",
  }));

  const downloadEvent = await spy.waitForMessage(
    { service: "s3", bucket: "spy-bucket", key: "test.txt", status: "downloaded" },
    undefined,
    5000,
  );
  console.log("S3 download tracked:", downloadEvent.status);

  await s3Client.send(new DeleteObjectCommand({
    Bucket: "spy-bucket",
    Key: "test.txt",
  }));

  const deleteEvent = await spy.waitForMessage(
    { service: "s3", bucket: "spy-bucket", key: "test.txt", status: "deleted" },
    undefined,
    5000,
  );
  console.log("S3 delete tracked:", deleteEvent.status);

  // ---------------------------------------------------------------
  // DLQ tracking
  // ---------------------------------------------------------------

  const dlqUrl = `http://sqs.us-east-1.127.0.0.1:${server.port}/000000000000/spy-queue-with-dlq`;

  await sqsClient.send(new SendMessageCommand({
    QueueUrl: dlqUrl,
    MessageBody: "will be DLQ'd",
  }));

  // Receive twice to exceed maxReceiveCount (1). With VisibilityTimeout=0,
  // the message becomes visible again immediately after each receive.
  await sqsClient.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await sqsClient.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 1 }));

  const dlqEvent = await spy.waitForMessage(
    { service: "sqs", status: "dlq" },
    undefined,
    5000,
  );
  if (dlqEvent.service === "sqs") {
    console.log("DLQ event:", dlqEvent.queueName);
  }

  // ---------------------------------------------------------------
  // clear — reset the spy buffer
  // ---------------------------------------------------------------

  spy.clear();
  console.log("Buffer after clear:", spy.getAllMessages().length); // 0

  await server.stop();
}

main().catch(console.error);
