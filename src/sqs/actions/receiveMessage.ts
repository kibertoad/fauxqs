import { SqsError } from "../../common/errors.ts";
import type { SqsStore } from "../sqsStore.ts";
import type { SqsMessage, ReceivedMessage } from "../sqsTypes.ts";

export async function receiveMessage(
  body: Record<string, unknown>,
  store: SqsStore,
): Promise<unknown> {
  const queueUrl = body.QueueUrl as string | undefined;
  if (!queueUrl) {
    throw new SqsError("InvalidParameterValue", "QueueUrl is required");
  }

  const queue = store.getQueue(queueUrl);
  if (!queue) {
    throw new SqsError("NonExistentQueue", "The specified queue does not exist.", 400);
  }

  const maxNumberOfMessages = (body.MaxNumberOfMessages as number) ?? 1;
  const visibilityTimeout = body.VisibilityTimeout as number | undefined;
  const waitTimeSeconds =
    (body.WaitTimeSeconds as number) ?? parseInt(queue.attributes.ReceiveMessageWaitTimeSeconds);

  const dlqResolver = (arn: string) => store.getQueueByArn(arn);

  let messages = queue.dequeue(maxNumberOfMessages, visibilityTimeout, dlqResolver);

  // Long polling: if no messages and WaitTimeSeconds > 0, wait
  if (messages.length === 0 && waitTimeSeconds > 0) {
    const waitedMsgs = await queue.waitForMessages(maxNumberOfMessages, waitTimeSeconds);

    if (waitedMsgs.length > 0) {
      // Process the waited messages through the normal dequeue path
      // Put them back temporarily and dequeue properly
      if (queue.isFifo()) {
        for (const msg of waitedMsgs) {
          const groupId = msg.messageGroupId ?? "__default";
          const group = queue.fifoMessages.get(groupId) ?? [];
          group.unshift(msg);
          queue.fifoMessages.set(groupId, group);
        }
      } else {
        for (const msg of waitedMsgs) {
          queue.messages.unshift(msg);
        }
      }
      messages = queue.dequeue(maxNumberOfMessages, visibilityTimeout, dlqResolver);
    }
  }

  // Add system attributes if requested (merge both legacy and modern parameter names)
  const legacyNames = (body.AttributeNames as string[] | undefined) ?? [];
  const modernNames = (body.MessageSystemAttributeNames as string[] | undefined) ?? [];
  const systemAttributeNames = [...legacyNames, ...modernNames];

  if (systemAttributeNames.length > 0) {
    addSystemAttributes(messages, queue, systemAttributeNames);
  }

  return { Messages: messages.length > 0 ? messages : undefined };
}

function addSystemAttributes(
  messages: ReceivedMessage[],
  queue: { inflightMessages: Map<string, { message: SqsMessage }> },
  systemAttributeNames: string[],
): void {
  for (const msg of messages) {
    const entry = queue.inflightMessages.get(msg.ReceiptHandle);
    if (!entry) continue;

    const attrs: Record<string, string> = {};
    const wantsAll = systemAttributeNames.includes("All");

    if (wantsAll || systemAttributeNames.includes("SenderId")) {
      attrs.SenderId = "000000000000";
    }
    if (wantsAll || systemAttributeNames.includes("SentTimestamp")) {
      attrs.SentTimestamp = String(entry.message.sentTimestamp);
    }
    if (wantsAll || systemAttributeNames.includes("ApproximateReceiveCount")) {
      attrs.ApproximateReceiveCount = String(entry.message.approximateReceiveCount);
    }
    if (wantsAll || systemAttributeNames.includes("ApproximateFirstReceiveTimestamp")) {
      attrs.ApproximateFirstReceiveTimestamp = String(
        entry.message.approximateFirstReceiveTimestamp ?? "",
      );
    }
    if (wantsAll || systemAttributeNames.includes("MessageGroupId")) {
      if (entry.message.messageGroupId) {
        attrs.MessageGroupId = entry.message.messageGroupId;
      }
    }
    if (wantsAll || systemAttributeNames.includes("MessageDeduplicationId")) {
      if (entry.message.messageDeduplicationId) {
        attrs.MessageDeduplicationId = entry.message.messageDeduplicationId;
      }
    }
    if (wantsAll || systemAttributeNames.includes("SequenceNumber")) {
      if (entry.message.sequenceNumber) {
        attrs.SequenceNumber = entry.message.sequenceNumber;
      }
    }

    if (Object.keys(attrs).length > 0) {
      msg.Attributes = attrs;
    }
  }
}
