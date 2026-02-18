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
  "KmsMasterKeyId",
  "KmsDataKeyReusePeriodSeconds",
  "FifoQueue",
  "ContentBasedDeduplication",
]);

// AWS SQS allowed unicode characters: #x9 | #xA | #xD | #x20 to #xD7FF | #xE000 to #xFFFD
// eslint-disable-next-line no-control-regex
export const INVALID_MESSAGE_BODY_CHAR = /[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD]/;

// Max message size: 1 MiB (1,048,576 bytes) for SQS
export const SQS_MAX_MESSAGE_SIZE_BYTES = 1_048_576;

// Max message size: 256 KB (262,144 bytes) for SNS
export const SNS_MAX_MESSAGE_SIZE_BYTES = 262_144;

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
  "KmsMasterKeyId",
  "KmsDataKeyReusePeriodSeconds",
  "FifoQueue",
  "ContentBasedDeduplication",
  "DeduplicationScope",
  "FifoThroughputLimit",
];
