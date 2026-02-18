import { SQSClient } from "@aws-sdk/client-sqs";
import { SNSClient } from "@aws-sdk/client-sns";

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
