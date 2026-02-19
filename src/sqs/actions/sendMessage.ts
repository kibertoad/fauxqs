import { SqsError } from "../../common/errors.ts";
import { md5, md5OfMessageAttributes } from "../../common/md5.ts";
import type { SqsStore } from "../sqsStore.ts";
import { SqsStore as SqsStoreClass } from "../sqsStore.ts";
import type { MessageAttributeValue } from "../sqsTypes.ts";
import { INVALID_MESSAGE_BODY_CHAR, calculateMessageSize } from "../sqsTypes.ts";

export function sendMessage(body: Record<string, unknown>, store: SqsStore): unknown {
  const queueUrl = body.QueueUrl as string | undefined;
  if (!queueUrl) {
    throw new SqsError("InvalidParameterValue", "QueueUrl is required");
  }

  const queue = store.getQueue(queueUrl);
  if (!queue) {
    throw new SqsError("NonExistentQueue", "The specified queue does not exist.", 400);
  }

  const messageBody = body.MessageBody as string | undefined;
  if (!messageBody) {
    throw new SqsError("MissingParameter", "The request must contain the parameter MessageBody.");
  }

  if (INVALID_MESSAGE_BODY_CHAR.test(messageBody)) {
    throw new SqsError(
      "InvalidMessageContents",
      "Invalid characters found. Valid unicode characters are #x9 | #xA | #xD | #x20 to #xD7FF and #xE000 to #xFFFD.",
    );
  }

  const messageAttributes = (body.MessageAttributes as Record<string, MessageAttributeValue>) ?? {};

  const maxMessageSize = parseInt(queue.attributes.MaximumMessageSize);
  const totalSize = calculateMessageSize(messageBody, messageAttributes);
  if (totalSize > maxMessageSize) {
    throw new SqsError(
      "InvalidParameterValue",
      `One or more parameters are invalid. Reason: Message must be shorter than ${maxMessageSize} bytes.`,
    );
  }

  if (queue.isFifo()) {
    return sendFifoMessage(body, queue, messageBody, messageAttributes);
  }

  // DelaySeconds: per-message override or queue default
  const delaySeconds =
    (body.DelaySeconds as number | undefined) ?? parseInt(queue.attributes.DelaySeconds);

  const msg = SqsStoreClass.createMessage(
    messageBody,
    messageAttributes,
    delaySeconds > 0 ? delaySeconds : undefined,
  );

  queue.enqueue(msg);

  const result: Record<string, unknown> = {
    MessageId: msg.messageId,
    MD5OfMessageBody: msg.md5OfBody,
  };

  if (msg.md5OfMessageAttributes) {
    result.MD5OfMessageAttributes = msg.md5OfMessageAttributes;
  }

  return result;
}

function sendFifoMessage(
  body: Record<string, unknown>,
  queue: import("../sqsStore.ts").SqsQueue,
  messageBody: string,
  messageAttributes: Record<string, MessageAttributeValue>,
): unknown {
  const messageGroupId = body.MessageGroupId as string | undefined;
  if (!messageGroupId) {
    throw new SqsError(
      "MissingParameter",
      "The request must contain the parameter MessageGroupId.",
    );
  }

  // Per-message DelaySeconds is not supported on FIFO queues
  if (body.DelaySeconds !== undefined && body.DelaySeconds !== 0) {
    throw new SqsError(
      "InvalidParameterValue",
      "Value 0 for parameter DelaySeconds is invalid. Reason: The request include parameter that is not valid for this queue type.",
    );
  }

  let messageDeduplicationId = body.MessageDeduplicationId as string | undefined;
  const contentBasedDedup = queue.attributes.ContentBasedDeduplication === "true";

  if (!messageDeduplicationId) {
    if (contentBasedDedup) {
      messageDeduplicationId = SqsStoreClass.contentBasedDeduplicationId(messageBody);
    } else {
      throw new SqsError(
        "InvalidParameterValue",
        "The queue should either have ContentBasedDeduplication enabled or MessageDeduplicationId provided explicitly.",
      );
    }
  }

  // Check deduplication
  const dedupResult = queue.checkDeduplication(messageDeduplicationId);
  if (dedupResult.isDuplicate) {
    // Return the original message ID and sequence number without re-enqueue
    const result: Record<string, unknown> = {
      MessageId: dedupResult.originalMessageId,
      MD5OfMessageBody: md5(messageBody),
    };
    const attrsDigest = md5OfMessageAttributes(messageAttributes);
    if (attrsDigest) {
      result.MD5OfMessageAttributes = attrsDigest;
    }
    result.SequenceNumber = dedupResult.originalSequenceNumber;
    return result;
  }

  // Queue-level delay applies to FIFO queues
  const queueDelay = parseInt(queue.attributes.DelaySeconds);
  const msg = SqsStoreClass.createMessage(
    messageBody,
    messageAttributes,
    queueDelay > 0 ? queueDelay : undefined,
    messageGroupId,
    messageDeduplicationId,
  );

  msg.sequenceNumber = queue.nextSequenceNumber();
  queue.recordDeduplication(messageDeduplicationId, msg.messageId, msg.sequenceNumber);
  queue.enqueue(msg);

  const result: Record<string, unknown> = {
    MessageId: msg.messageId,
    MD5OfMessageBody: msg.md5OfBody,
    SequenceNumber: msg.sequenceNumber,
  };

  if (msg.md5OfMessageAttributes) {
    result.MD5OfMessageAttributes = msg.md5OfMessageAttributes;
  }

  return result;
}
