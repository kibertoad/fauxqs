export interface MessageAttributeValue {
  DataType: string;
  StringValue?: string;
  BinaryValue?: string;
}

export interface SqsMessage {
  messageId: string;
  body: string;
  md5OfBody: string;
  messageAttributes: Record<string, MessageAttributeValue>;
  md5OfMessageAttributes: string;
  sentTimestamp: number;
  approximateReceiveCount: number;
  approximateFirstReceiveTimestamp?: number;
  delayUntil?: number;
  messageGroupId?: string;
  messageDeduplicationId?: string;
  sequenceNumber?: string;
}

export interface InflightEntry {
  message: SqsMessage;
  receiptHandle: string;
  visibilityDeadline: number;
}

export interface ReceivedMessage {
  MessageId: string;
  ReceiptHandle: string;
  MD5OfBody: string;
  Body: string;
  Attributes?: Record<string, string>;
  MD5OfMessageAttributes?: string;
  MessageAttributes?: Record<string, MessageAttributeValue>;
}

export const DEFAULT_QUEUE_ATTRIBUTES: Record<string, string> = {
  VisibilityTimeout: "30",
  DelaySeconds: "0",
  MaximumMessageSize: "262144",
  MessageRetentionPeriod: "345600",
  ReceiveMessageWaitTimeSeconds: "0",
};

export const SETTABLE_ATTRIBUTES = new Set([
  "VisibilityTimeout",
  "DelaySeconds",
  "MaximumMessageSize",
  "MessageRetentionPeriod",
  "ReceiveMessageWaitTimeSeconds",
  "RedrivePolicy",
  "Policy",
]);

export const ALL_ATTRIBUTE_NAMES = [
  "QueueArn",
  "VisibilityTimeout",
  "DelaySeconds",
  "MaximumMessageSize",
  "MessageRetentionPeriod",
  "ReceiveMessageWaitTimeSeconds",
  "ApproximateNumberOfMessages",
  "ApproximateNumberOfMessagesNotVisible",
  "ApproximateNumberOfMessagesDelayed",
  "CreatedTimestamp",
  "LastModifiedTimestamp",
  "RedrivePolicy",
  "Policy",
];
