import { SQSClient } from "@aws-sdk/client-sqs";
import { SNSClient } from "@aws-sdk/client-sns";

export function createSqsClient(port: number): SQSClient {
  return new SQSClient({
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${port}`,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

export function createSnsClient(port: number): SNSClient {
  return new SNSClient({
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${port}`,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}
