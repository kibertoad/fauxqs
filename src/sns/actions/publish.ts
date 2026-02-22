import { randomUUID } from "node:crypto";
import type { PublishResponse } from "@aws-sdk/client-sns";
import { SnsError } from "../../common/errors.ts";
import { snsSuccessResponse } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";
import type { SqsStore } from "../../sqs/sqsStore.ts";
import { SqsStore as SqsStoreClass } from "../../sqs/sqsStore.ts";
import type { MessageAttributeValue } from "../../sqs/sqsTypes.ts";
import { SNS_MAX_MESSAGE_SIZE_BYTES } from "../../common/types.ts";
import { matchesFilterPolicy, matchesFilterPolicyOnBody } from "../filter.ts";

export function publish(
  params: Record<string, string>,
  snsStore: SnsStore,
  sqsStore: SqsStore,
): string {
  const topicArn = params.TopicArn;
  if (!topicArn) {
    throw new SnsError("InvalidParameter", "TopicArn is required");
  }

  const topic = snsStore.getTopic(topicArn);
  if (!topic) {
    throw new SnsError("NotFound", "Topic does not exist", 404);
  }

  const message = params.Message;
  if (!message) {
    throw new SnsError("InvalidParameter", "Message is required");
  }

  // Parse message attributes before size check so we can include attribute sizes
  const messageAttributes = parseMessageAttributes(params);

  // Calculate total size including attributes
  let totalSize = Buffer.byteLength(message, "utf8");
  for (const [name, attr] of Object.entries(messageAttributes)) {
    totalSize += Buffer.byteLength(name, "utf8");
    totalSize += Buffer.byteLength(attr.DataType, "utf8");
    if (attr.StringValue) totalSize += Buffer.byteLength(attr.StringValue, "utf8");
    if (attr.BinaryValue) totalSize += Buffer.byteLength(attr.BinaryValue, "utf8");
  }
  if (totalSize > SNS_MAX_MESSAGE_SIZE_BYTES) {
    throw new SnsError(
      "InvalidParameter",
      `Invalid parameter: Message too long. Message must be shorter than ${SNS_MAX_MESSAGE_SIZE_BYTES} bytes.`,
    );
  }

  const messageId = randomUUID();
  const subject = params.Subject;

  // Emit SNS spy event
  if (snsStore.spy) {
    snsStore.spy.addMessage({
      service: "sns",
      topicArn,
      topicName: topic.name,
      messageId,
      body: message,
      messageAttributes,
      status: "published",
      timestamp: Date.now(),
    });
  }

  // FIFO topic handling
  const isFifoTopic = topic.attributes.FifoTopic === "true";
  let messageGroupId: string | undefined;
  let messageDeduplicationId: string | undefined;

  if (isFifoTopic) {
    messageGroupId = params.MessageGroupId;
    if (!messageGroupId) {
      throw new SnsError(
        "InvalidParameter",
        "Invalid parameter: The MessageGroupId parameter is required for FIFO topics.",
      );
    }

    messageDeduplicationId = params.MessageDeduplicationId;
    if (!messageDeduplicationId) {
      if (topic.attributes.ContentBasedDeduplication === "true") {
        messageDeduplicationId = SqsStoreClass.contentBasedDeduplicationId(message);
      } else {
        throw new SnsError(
          "InvalidParameter",
          "Invalid parameter: The topic should either have ContentBasedDeduplication enabled or MessageDeduplicationId provided explicitly.",
        );
      }
    }
  }

  // Fan out to subscriptions
  fanOutToSubscriptions({
    topicArn,
    topic,
    messageId,
    message,
    messageAttributes,
    subject,
    messageGroupId,
    messageDeduplicationId,
    snsStore,
    sqsStore,
  });

  const result = { MessageId: messageId } satisfies PublishResponse;
  return snsSuccessResponse("Publish", `<MessageId>${result.MessageId}</MessageId>`);
}

export function publishBatch(
  params: Record<string, string>,
  snsStore: SnsStore,
  sqsStore: SqsStore,
): string {
  const topicArn = params.TopicArn;
  if (!topicArn) {
    throw new SnsError("InvalidParameter", "TopicArn is required");
  }

  const topic = snsStore.getTopic(topicArn);
  if (!topic) {
    throw new SnsError("NotFound", "Topic does not exist", 404);
  }

  // Parse batch entries from flattened form params
  const entries = parseBatchEntries(params);

  // Validate batch constraints
  if (entries.length === 0) {
    throw new SnsError("EmptyBatchRequest", "The batch request doesn't contain any entries.", 400);
  }
  if (entries.length > 10) {
    throw new SnsError(
      "TooManyEntriesInBatchRequest",
      "The batch request contains more entries than permissible.",
      400,
    );
  }
  const VALID_BATCH_ENTRY_ID = /^[A-Za-z0-9_-]{1,80}$/;
  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (!VALID_BATCH_ENTRY_ID.test(entry.id)) {
      throw new SnsError(
        "InvalidBatchEntryId",
        `A batch entry id can only contain alphanumeric characters, hyphens and underscores. It can be at most 80 letters long.`,
        400,
      );
    }
    if (seenIds.has(entry.id)) {
      throw new SnsError(
        "BatchEntryIdsNotDistinct",
        "Two or more batch entries in the request have the same Id.",
        400,
      );
    }
    seenIds.add(entry.id);
  }

  const isFifoTopic = topic.attributes.FifoTopic === "true";

  const successfulXml: string[] = [];
  const failedXml: string[] = [];

  for (const entry of entries) {
    // Calculate total size including attributes
    let entrySize = Buffer.byteLength(entry.message, "utf8");
    for (const [name, attr] of Object.entries(entry.messageAttributes)) {
      entrySize += Buffer.byteLength(name, "utf8");
      entrySize += Buffer.byteLength(attr.DataType, "utf8");
      if (attr.StringValue) entrySize += Buffer.byteLength(attr.StringValue, "utf8");
      if (attr.BinaryValue) entrySize += Buffer.byteLength(attr.BinaryValue, "utf8");
    }
    if (entrySize > SNS_MAX_MESSAGE_SIZE_BYTES) {
      failedXml.push(
        `<member><Id>${entry.id}</Id><Code>InvalidParameter</Code><Message>Message too long</Message><SenderFault>true</SenderFault></member>`,
      );
      continue;
    }

    let messageGroupId: string | undefined;
    let messageDeduplicationId: string | undefined;

    if (isFifoTopic) {
      messageGroupId = entry.messageGroupId;
      if (!messageGroupId) {
        failedXml.push(
          `<member><Id>${entry.id}</Id><Code>InvalidParameter</Code><Message>The MessageGroupId parameter is required for FIFO topics.</Message><SenderFault>true</SenderFault></member>`,
        );
        continue;
      }

      messageDeduplicationId = entry.messageDeduplicationId;
      if (!messageDeduplicationId) {
        if (topic.attributes.ContentBasedDeduplication === "true") {
          messageDeduplicationId = SqsStoreClass.contentBasedDeduplicationId(entry.message);
        } else {
          failedXml.push(
            `<member><Id>${entry.id}</Id><Code>InvalidParameter</Code><Message>The topic should either have ContentBasedDeduplication enabled or MessageDeduplicationId provided explicitly.</Message><SenderFault>true</SenderFault></member>`,
          );
          continue;
        }
      }
    }

    const messageId = randomUUID();

    // Emit SNS spy event
    if (snsStore.spy) {
      snsStore.spy.addMessage({
        service: "sns",
        topicArn,
        topicName: topic.name,
        messageId,
        body: entry.message,
        messageAttributes: entry.messageAttributes,
        status: "published",
        timestamp: Date.now(),
      });
    }

    // Fan out each entry
    fanOutToSubscriptions({
      topicArn,
      topic,
      messageId,
      message: entry.message,
      messageAttributes: entry.messageAttributes,
      subject: entry.subject,
      messageGroupId,
      messageDeduplicationId,
      snsStore,
      sqsStore,
    });

    successfulXml.push(`<member><Id>${entry.id}</Id><MessageId>${messageId}</MessageId></member>`);
  }

  return snsSuccessResponse(
    "PublishBatch",
    `<Successful>${successfulXml.join("")}</Successful><Failed>${failedXml.join("")}</Failed>`,
  );
}

export function fanOutToSubscriptions(params: {
  topicArn: string;
  topic: { subscriptionArns: string[] };
  messageId: string;
  message: string;
  messageAttributes: Record<string, MessageAttributeValue>;
  subject?: string;
  messageGroupId?: string;
  messageDeduplicationId?: string;
  snsStore: SnsStore;
  sqsStore: SqsStore;
}): void {
  const {
    topicArn,
    topic,
    messageId,
    message,
    messageAttributes,
    subject,
    messageGroupId,
    messageDeduplicationId,
    snsStore,
    sqsStore,
  } = params;

  // Pre-compute envelope fields shared across subscriptions (only UnsubscribeURL varies)
  const envelopeBase = {
    Type: "Notification" as const,
    MessageId: messageId,
    TopicArn: topicArn,
    Subject: subject ?? null,
    Message: message,
    Timestamp: new Date().toISOString(),
    SignatureVersion: "1" as const,
    Signature: "EXAMPLE" as const,
    SigningCertURL:
      "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0000000000000000000000.pem" as const,
    UnsubscribeURL: "",
    MessageAttributes: formatEnvelopeAttributes(messageAttributes),
  };

  for (const subArn of topic.subscriptionArns) {
    const sub = snsStore.getSubscription(subArn);
    if (!sub || !sub.confirmed) continue;
    if (sub.protocol !== "sqs") continue;

    // Filter policy check
    if (sub.attributes.FilterPolicy) {
      try {
        // Use cached parsed policy to avoid JSON.parse on every publish
        if (sub.parsedFilterPolicy === undefined) {
          sub.parsedFilterPolicy = JSON.parse(sub.attributes.FilterPolicy);
        }
        const filterPolicy = sub.parsedFilterPolicy!;
        const scope = sub.attributes.FilterPolicyScope ?? "MessageAttributes";

        if (scope === "MessageBody") {
          if (!matchesFilterPolicyOnBody(filterPolicy, message)) continue;
        } else {
          if (!matchesFilterPolicy(filterPolicy, messageAttributes)) continue;
        }
      } catch {
        // Invalid filter policy JSON — fail-open: deliver the message rather than silently dropping it.
      }
    }

    const sqsQueueArn = sub.endpoint;
    const queue = sqsStore.getQueueByArn(sqsQueueArn);
    if (!queue) continue;

    const isRaw = sub.attributes.RawMessageDelivery === "true";

    let sqsBody: string;
    let sqsAttributes: Record<string, MessageAttributeValue> = {};

    if (isRaw) {
      sqsBody = message;
      sqsAttributes = messageAttributes;
    } else {
      envelopeBase.UnsubscribeURL = `https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=${sub.arn}`;
      sqsBody = JSON.stringify(envelopeBase);
    }

    const sqsMsg = SqsStoreClass.createMessage(
      sqsBody,
      sqsAttributes,
      undefined,
      messageGroupId,
      messageDeduplicationId,
    );

    if (queue.isFifo() && messageDeduplicationId) {
      const dedupResult = queue.checkDeduplication(messageDeduplicationId);
      if (dedupResult.isDuplicate) continue;
      sqsMsg.sequenceNumber = queue.nextSequenceNumber();
      queue.recordDeduplication(messageDeduplicationId, sqsMsg.messageId);
    }

    queue.enqueue(sqsMsg);
  }
}

function parseMessageAttributes(
  params: Record<string, string>,
): Record<string, MessageAttributeValue> {
  const result: Record<string, MessageAttributeValue> = {};
  const indices = new Set<string>();

  for (const key of Object.keys(params)) {
    const match = key.match(/^MessageAttributes\.entry\.(\d+)\./);
    if (match) {
      indices.add(match[1]);
    }
  }

  for (const idx of indices) {
    const name = params[`MessageAttributes.entry.${idx}.Name`];
    const dataType = params[`MessageAttributes.entry.${idx}.Value.DataType`];
    const stringValue = params[`MessageAttributes.entry.${idx}.Value.StringValue`];
    const binaryValue = params[`MessageAttributes.entry.${idx}.Value.BinaryValue`];

    if (name && dataType) {
      result[name] = { DataType: dataType };
      if (stringValue !== undefined) result[name].StringValue = stringValue;
      if (binaryValue !== undefined) result[name].BinaryValue = binaryValue;
    }
  }

  return result;
}

function parseBatchEntries(params: Record<string, string>): Array<{
  id: string;
  message: string;
  subject?: string;
  messageGroupId?: string;
  messageDeduplicationId?: string;
  messageAttributes: Record<string, MessageAttributeValue>;
}> {
  const entries: Array<{
    id: string;
    message: string;
    subject?: string;
    messageGroupId?: string;
    messageDeduplicationId?: string;
    messageAttributes: Record<string, MessageAttributeValue>;
  }> = [];
  const indices = new Set<string>();

  for (const key of Object.keys(params)) {
    const match = key.match(/^PublishBatchRequestEntries\.member\.(\d+)\./);
    if (match) {
      indices.add(match[1]);
    }
  }

  for (const idx of indices) {
    const prefix = `PublishBatchRequestEntries.member.${idx}`;
    const id = params[`${prefix}.Id`];
    const message = params[`${prefix}.Message`];
    const subject = params[`${prefix}.Subject`];
    const messageGroupId = params[`${prefix}.MessageGroupId`];
    const messageDeduplicationId = params[`${prefix}.MessageDeduplicationId`];

    // Parse message attributes for this entry
    const messageAttributes: Record<string, MessageAttributeValue> = {};
    const attrIndices = new Set<string>();
    const attrPrefix = `${prefix}.MessageAttributes.entry.`;
    for (const key of Object.keys(params)) {
      if (key.startsWith(attrPrefix)) {
        const attrMatch = key.slice(attrPrefix.length).match(/^(\d+)\./);
        if (attrMatch) {
          attrIndices.add(attrMatch[1]);
        }
      }
    }
    for (const attrIdx of attrIndices) {
      const name = params[`${attrPrefix}${attrIdx}.Name`];
      const dataType = params[`${attrPrefix}${attrIdx}.Value.DataType`];
      const stringValue = params[`${attrPrefix}${attrIdx}.Value.StringValue`];
      const binaryValue = params[`${attrPrefix}${attrIdx}.Value.BinaryValue`];
      if (name && dataType) {
        messageAttributes[name] = { DataType: dataType };
        if (stringValue !== undefined) messageAttributes[name].StringValue = stringValue;
        if (binaryValue !== undefined) messageAttributes[name].BinaryValue = binaryValue;
      }
    }

    if (id && message) {
      entries.push({
        id,
        message,
        subject,
        messageGroupId,
        messageDeduplicationId,
        messageAttributes,
      });
    }
  }

  return entries;
}

function formatEnvelopeAttributes(
  attributes: Record<string, MessageAttributeValue>,
): Record<string, { Type: string; Value: string }> {
  const result: Record<string, { Type: string; Value: string }> = {};
  for (const [key, attr] of Object.entries(attributes)) {
    result[key] = {
      Type: attr.DataType,
      Value: attr.StringValue ?? attr.BinaryValue ?? "",
    };
  }
  return result;
}
