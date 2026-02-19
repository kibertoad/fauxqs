import assert from "node:assert";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import {
  SQSClient,
  SendMessageCommand,
  GetQueueUrlCommand,
} from "@aws-sdk/client-sqs";

const BUCKET = "acceptance-bucket";
const KEY = "hello.txt";
const BODY = "Hello from container-to-container test!";
const QUEUE_NAME = "acceptance-results";

async function main() {
  // S3 client with virtual-hosted-style (NO forcePathStyle) — relies on dnsmasq
  const s3 = new S3Client({
    endpoint: "http://s3.fauxqs:4566",
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });

  // SQS client
  const sqs = new SQSClient({
    endpoint: "http://fauxqs:4566",
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });

  // Upload object to S3 (virtual-hosted-style: acceptance-bucket.s3.fauxqs:4566)
  console.log(`Uploading ${KEY} to s3://${BUCKET}...`);
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: KEY,
      Body: BODY,
      ContentType: "text/plain",
    }),
  );
  console.log("Upload OK");

  // Download and verify
  console.log(`Downloading ${KEY} from s3://${BUCKET}...`);
  const getResult = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: KEY }),
  );
  const downloaded = await getResult.Body!.transformToString();
  assert.strictEqual(downloaded, BODY, "S3 body mismatch");
  console.log("Download OK — content matches");

  // Get queue URL
  const { QueueUrl } = await sqs.send(
    new GetQueueUrlCommand({ QueueName: QUEUE_NAME }),
  );
  console.log(`Queue URL: ${QueueUrl}`);

  // Send PASS message to SQS
  console.log("Sending PASS message to SQS...");
  await sqs.send(
    new SendMessageCommand({
      QueueUrl,
      MessageBody: "PASS",
    }),
  );
  console.log("SQS send OK");

  console.log("\nAll container-to-container tests passed!");
}

main().catch((err) => {
  console.error("\nTest FAILED:", err);
  process.exit(1);
});
