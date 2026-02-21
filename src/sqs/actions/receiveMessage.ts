import type {
  MessageSystemAttributeName,
  ReceiveMessageResult,
  Message,
} from "@aws-sdk/client-sqs";
import { SqsError, QueueDoesNotExistError } from "../../common/errors.ts";
import type { SqsStore } from "../sqsStore.ts";
import type { SqsMessage, ReceivedMessage, MessageAttributeValue } from "../sqsTypes.ts";

export async function receiveMessage(
  body: Record<string, unknown>,
  store: SqsStore,
): Promise<ReceiveMessageResult> {
  const queueUrl = body.QueueUrl as string | undefined;
  if (!queueUrl) {
    throw new SqsError("InvalidParameterValue", "QueueUrl is required");
  }

  const queue = store.getQueue(queueUrl);
  if (!queue) {
    throw new QueueDoesNotExistError();
  }

  const maxNumberOfMessages = (body.MaxNumberOfMessages as number) ?? 1;
  if (maxNumberOfMessages < 1 || maxNumberOfMessages > 10) {
    throw new SqsError(
      "InvalidParameterValue",
      "Value for parameter MaxNumberOfMessages is invalid. Reason: Must be between 1 and 10.",
    );
  }
  const visibilityTimeout = body.VisibilityTimeout as number | undefined;
  if (visibilityTimeout !== undefined && (visibilityTimeout < 0 || visibilityTimeout > 43200)) {
    throw new SqsError(
      "InvalidParameterValue",
      `Value ${visibilityTimeout} for parameter VisibilityTimeout is invalid. Reason: Must be between 0 and 43200.`,
    );
  }
  const waitTimeSeconds =
    (body.WaitTimeSeconds as number) ?? parseInt(queue.attributes.ReceiveMessageWaitTimeSeconds);
  if (waitTimeSeconds < 0 || waitTimeSeconds > 20) {
    throw new SqsError(
      "InvalidParameterValue",
      `Value ${waitTimeSeconds} for parameter WaitTimeSeconds is invalid. Reason: Must be >= 0 and <= 20, if provided.`,
    );
  }

  const dlqResolver = (arn: string) => store.getQueueByArn(arn);

  let messages = queue.dequeue(maxNumberOfMessages, visibilityTimeout, dlqResolver);

  // Long polling: if no messages and WaitTimeSeconds > 0, wait
  if (messages.length === 0 && waitTimeSeconds > 0) {
    await queue.waitForMessages(waitTimeSeconds);
    messages = queue.dequeue(maxNumberOfMessages, visibilityTimeout, dlqResolver);
  }

  // Add system attributes if requested (merge both legacy and modern parameter names)
  const legacyNames = (body.AttributeNames as string[] | undefined) ?? [];
  const modernNames = (body.MessageSystemAttributeNames as string[] | undefined) ?? [];
  const systemAttributeNames = [...legacyNames, ...modernNames];

  if (systemAttributeNames.length > 0) {
    addSystemAttributes(messages, queue, systemAttributeNames);
  }

  // Filter message attributes if MessageAttributeNames is specified
  const messageAttributeNames = (body.MessageAttributeNames as string[] | undefined) ?? [];
  if (messageAttributeNames.length > 0) {
    filterMessageAttributes(messages, messageAttributeNames);
  }

  return {
    Messages: messages.length > 0 ? (messages as Message[]) : undefined,
  } satisfies ReceiveMessageResult;
}

function wants(
  systemAttributeNames: string[],
  wantsAll: boolean,
  name: MessageSystemAttributeName,
): boolean {
  return wantsAll || systemAttributeNames.includes(name);
}

function addSystemAttributes(
  messages: ReceivedMessage[],
  queue: { inflightMessages: Map<string, { message: SqsMessage }> },
  systemAttributeNames: string[],
): void {
  for (const msg of messages) {
    const entry = queue.inflightMessages.get(msg.ReceiptHandle);
    if (!entry) continue;

    const attrs: Partial<Record<MessageSystemAttributeName, string>> = {};
    const wantsAll = systemAttributeNames.includes("All");

    if (wants(systemAttributeNames, wantsAll, "SenderId")) {
      attrs.SenderId = "000000000000";
    }
    if (wants(systemAttributeNames, wantsAll, "SentTimestamp")) {
      attrs.SentTimestamp = String(entry.message.sentTimestamp);
    }
    if (wants(systemAttributeNames, wantsAll, "ApproximateReceiveCount")) {
      attrs.ApproximateReceiveCount = String(entry.message.approximateReceiveCount);
    }
    if (wants(systemAttributeNames, wantsAll, "ApproximateFirstReceiveTimestamp")) {
      if (entry.message.approximateFirstReceiveTimestamp) {
        attrs.ApproximateFirstReceiveTimestamp = String(
          entry.message.approximateFirstReceiveTimestamp,
        );
      }
    }
    if (wants(systemAttributeNames, wantsAll, "MessageGroupId")) {
      if (entry.message.messageGroupId) {
        attrs.MessageGroupId = entry.message.messageGroupId;
      }
    }
    if (wants(systemAttributeNames, wantsAll, "MessageDeduplicationId")) {
      if (entry.message.messageDeduplicationId) {
        attrs.MessageDeduplicationId = entry.message.messageDeduplicationId;
      }
    }
    if (wants(systemAttributeNames, wantsAll, "SequenceNumber")) {
      if (entry.message.sequenceNumber) {
        attrs.SequenceNumber = entry.message.sequenceNumber;
      }
    }

    if (Object.keys(attrs).length > 0) {
      msg.Attributes = attrs as Record<string, string>;
    }
  }
}

function filterMessageAttributes(messages: ReceivedMessage[], requestedNames: string[]): void {
  const wantsAll = requestedNames.includes("All") || requestedNames.includes(".*");
  if (wantsAll) return;

  // Separate exact names from prefix patterns (e.g. "payloadOffloading.*")
  const exactNames: string[] = [];
  const prefixes: string[] = [];
  for (const name of requestedNames) {
    if (name.endsWith(".*")) {
      prefixes.push(name.slice(0, -1)); // "foo.*" → "foo."
    } else {
      exactNames.push(name);
    }
  }

  for (const msg of messages) {
    if (!msg.MessageAttributes) continue;
    const filtered: Record<string, MessageAttributeValue> = {};
    for (const attrName of Object.keys(msg.MessageAttributes)) {
      if (exactNames.includes(attrName) || prefixes.some((p) => attrName.startsWith(p))) {
        filtered[attrName] = msg.MessageAttributes[attrName];
      }
    }
    if (Object.keys(filtered).length > 0) {
      msg.MessageAttributes = filtered;
    } else {
      delete msg.MessageAttributes;
      delete msg.MD5OfMessageAttributes;
    }
  }
}
