import { DEFAULT_ACCOUNT_ID, DEFAULT_REGION } from "./types.js";

export function sqsQueueArn(queueName: string, region?: string): string {
  return `arn:aws:sqs:${region ?? DEFAULT_REGION}:${DEFAULT_ACCOUNT_ID}:${queueName}`;
}

export function snsTopicArn(topicName: string, region?: string): string {
  return `arn:aws:sns:${region ?? DEFAULT_REGION}:${DEFAULT_ACCOUNT_ID}:${topicName}`;
}

export function snsSubscriptionArn(topicName: string, id: string, region?: string): string {
  return `arn:aws:sns:${region ?? DEFAULT_REGION}:${DEFAULT_ACCOUNT_ID}:${topicName}:${id}`;
}

export function parseArn(arn: string) {
  const parts = arn.split(":");
  return {
    partition: parts[1],
    service: parts[2],
    region: parts[3],
    accountId: parts[4],
    resource: parts.slice(5).join(":"),
  };
}
