import type { QueueAttributeName } from "@aws-sdk/client-sqs";

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

export const DEFAULT_QUEUE_ATTRIBUTES = {
  VisibilityTimeout: "30",
  DelaySeconds: "0",
  MaximumMessageSize: "1048576",
  MessageRetentionPeriod: "345600",
  ReceiveMessageWaitTimeSeconds: "0",
} satisfies Partial<Record<QueueAttributeName, string>>;

export const SETTABLE_ATTRIBUTES: ReadonlySet<string> = new Set([
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
] satisfies QueueAttributeName[]);

export const VALID_BATCH_ENTRY_ID = /^[a-zA-Z0-9_-]+$/;

// AWS SQS allowed unicode characters: #x9 | #xA | #xD | #x20 to #xD7FF | #xE000 to #xFFFD
// eslint-disable-next-line no-control-regex
export const INVALID_MESSAGE_BODY_CHAR = /[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD]/;

// Max message size: 1 MiB (1,048,576 bytes) for SQS
export const SQS_MAX_MESSAGE_SIZE_BYTES = 1_048_576;

// Re-export from shared location for backwards compatibility
export { SNS_MAX_MESSAGE_SIZE_BYTES } from "../common/types.ts";

/**
 * Calculate total message size including body and all message attributes.
 * AWS counts: body bytes + for each attribute: name bytes + data type bytes + value bytes.
 */
export function calculateMessageSize(
  body: string,
  attributes: Record<string, MessageAttributeValue>,
): number {
  let size = Buffer.byteLength(body, "utf8");
  for (const [name, attr] of Object.entries(attributes)) {
    size += Buffer.byteLength(name, "utf8");
    size += Buffer.byteLength(attr.DataType, "utf8");
    if (attr.StringValue !== undefined) {
      size += Buffer.byteLength(attr.StringValue, "utf8");
    }
    if (attr.BinaryValue !== undefined) {
      size += Buffer.byteLength(attr.BinaryValue, "utf8");
    }
  }
  return size;
}

/**
 * Validates SQS queue attribute values are within AWS-specified ranges.
 * Throws SqsError for out-of-range values.
 */
export function validateQueueAttributes(
  attributes: Record<string, string>,
  SqsError: new (code: string, message: string, statusCode?: number) => Error,
): void {
  const ranges = {
    VisibilityTimeout: { min: 0, max: 43_200 },
    DelaySeconds: { min: 0, max: 900 },
    ReceiveMessageWaitTimeSeconds: { min: 0, max: 20 },
    MaximumMessageSize: { min: 1_024, max: 1_048_576 },
    MessageRetentionPeriod: { min: 60, max: 1_209_600 },
  } satisfies Partial<Record<QueueAttributeName, { min: number; max: number }>>;

  for (const [attr, range] of Object.entries(ranges)) {
    if (attr in attributes) {
      const value = Number(attributes[attr]);
      if (!Number.isInteger(value) || value < range.min || value > range.max) {
        throw new SqsError(
          "InvalidAttributeValue",
          `Invalid value for the parameter ${attr}. Reason: Must be between ${range.min} and ${range.max}.`,
        );
      }
    }
  }
}

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
] satisfies QueueAttributeName[];
