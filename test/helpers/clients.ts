import { SQSClient } from "@aws-sdk/client-sqs";
import { SNSClient } from "@aws-sdk/client-sns";
import { S3Client } from "@aws-sdk/client-s3";

export function createSqsClient(port: number, region = "us-east-1"): SQSClient {
  return new SQSClient({
    region,
    endpoint: `http://127.0.0.1:${port}`,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

export function createSnsClient(port: number, region = "us-east-1"): SNSClient {
  return new SNSClient({
    region,
    endpoint: `http://127.0.0.1:${port}`,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

export function createS3Client(port: number, region = "us-east-1"): S3Client {
  return new S3Client({
    region,
    endpoint: `http://127.0.0.1:${port}`,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    forcePathStyle: true,
  });
}
