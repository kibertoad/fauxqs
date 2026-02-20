import { randomUUID } from "node:crypto";
import type { PublishResponse } from "@aws-sdk/client-sns";
import { SnsError } from "../../common/errors.ts";
import { snsSuccessResponse } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";
import type { SqsStore } from "../../sqs/sqsStore.ts";
import { SqsStore as SqsStoreClass } from "../../sqs/sqsStore.ts";
import type { MessageAttributeValue } from "../../sqs/sqsTypes.ts";
import { SNS_MAX_MESSAGE_SIZE_BYTES } from "../../sqs/sqsTypes.ts";
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

  if (Buffer.byteLength(message, "utf8") > SNS_MAX_MESSAGE_SIZE_BYTES) {
    throw new SnsError(
      "InvalidParameter",
      `Invalid parameter: Message too long. Message must be shorter than ${SNS_MAX_MESSAGE_SIZE_BYTES} bytes.`,
    );
  }

  const messageId = randomUUID();
  const subject = params.Subject;

  // Parse message attributes
  const messageAttributes = parseMessageAttributes(params);

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

  // Pre-build envelope template for non-raw subscriptions (stringify once, not per subscription)
  const UNSUB_PLACEHOLDER = "__UNSUB_ARN_PLACEHOLDER__";
  const envelopeTemplate = JSON.stringify({
    Type: "Notification",
    MessageId: messageId,
    TopicArn: topicArn,
    Subject: subject ?? null,
    Message: message,
    Timestamp: new Date().toISOString(),
    SignatureVersion: "1",
    Signature: "EXAMPLE",
    SigningCertURL:
      "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0000000000000000000000.pem",
    UnsubscribeURL: UNSUB_PLACEHOLDER,
    MessageAttributes: formatEnvelopeAttributes(messageAttributes),
  });

  // Fan out to subscriptions
  for (const subArn of topic.subscriptionArns) {
    const sub = snsStore.getSubscription(subArn);
    if (!sub || !sub.confirmed) continue;
    if (sub.protocol !== "sqs") continue;

    // Filter policy check
    if (sub.attributes.FilterPolicy) {
      try {
        const filterPolicy = JSON.parse(sub.attributes.FilterPolicy);
        const scope = sub.attributes.FilterPolicyScope ?? "MessageAttributes";

        if (scope === "MessageBody") {
          if (!matchesFilterPolicyOnBody(filterPolicy, message)) continue;
        } else {
          if (!matchesFilterPolicy(filterPolicy, messageAttributes)) continue;
        }
      } catch {
        // Invalid filter policy, skip filtering
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
      // Wrap in SNS envelope (reuse pre-built template, only substitute UnsubscribeURL)
      sqsBody = envelopeTemplate.replace(
        UNSUB_PLACEHOLDER,
        `https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=${sub.arn}`,
      );
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
  const isFifoTopic = topic.attributes.FifoTopic === "true";

  const successfulXml: string[] = [];
  const failedXml: string[] = [];

  for (const entry of entries) {
    if (Buffer.byteLength(entry.message, "utf8") > SNS_MAX_MESSAGE_SIZE_BYTES) {
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
    for (const subArn of topic.subscriptionArns) {
      const sub = snsStore.getSubscription(subArn);
      if (!sub || !sub.confirmed || sub.protocol !== "sqs") continue;

      // Filter policy check
      if (sub.attributes.FilterPolicy) {
        try {
          const filterPolicy = JSON.parse(sub.attributes.FilterPolicy);
          const scope = sub.attributes.FilterPolicyScope ?? "MessageAttributes";

          if (scope === "MessageBody") {
            if (!matchesFilterPolicyOnBody(filterPolicy, entry.message)) continue;
          } else {
            if (!matchesFilterPolicy(filterPolicy, entry.messageAttributes)) continue;
          }
        } catch {
          // Invalid filter policy, skip filtering
        }
      }

      const queue = sqsStore.getQueueByArn(sub.endpoint);
      if (!queue) continue;

      const isRaw = sub.attributes.RawMessageDelivery === "true";
      let sqsBody: string;
      let sqsAttributes: Record<string, MessageAttributeValue> = {};

      if (isRaw) {
        sqsBody = entry.message;
        sqsAttributes = entry.messageAttributes;
      } else {
        sqsBody = JSON.stringify({
          Type: "Notification",
          MessageId: messageId,
          TopicArn: topicArn,
          Subject: entry.subject ?? null,
          Message: entry.message,
          Timestamp: new Date().toISOString(),
          SignatureVersion: "1",
          Signature: "EXAMPLE",
          SigningCertURL:
            "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0000000000000000000000.pem",
          UnsubscribeURL: `https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=${sub.arn}`,
          MessageAttributes: formatEnvelopeAttributes(entry.messageAttributes),
        });
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

    successfulXml.push(`<member><Id>${entry.id}</Id><MessageId>${messageId}</MessageId></member>`);
  }

  return snsSuccessResponse(
    "PublishBatch",
    `<Successful>${successfulXml.join("")}</Successful><Failed>${failedXml.join("")}</Failed>`,
  );
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
