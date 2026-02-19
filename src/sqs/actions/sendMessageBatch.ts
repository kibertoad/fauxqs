import { SqsError } from "../../common/errors.ts";
import { md5, md5OfMessageAttributes } from "../../common/md5.ts";
import type { SqsStore } from "../sqsStore.ts";
import { SqsStore as SqsStoreClass } from "../sqsStore.ts";
import type { MessageAttributeValue } from "../sqsTypes.ts";
import { INVALID_MESSAGE_BODY_CHAR, calculateMessageSize } from "../sqsTypes.ts";

interface BatchEntry {
  Id: string;
  MessageBody: string;
  DelaySeconds?: number;
  MessageAttributes?: Record<string, MessageAttributeValue>;
  MessageGroupId?: string;
  MessageDeduplicationId?: string;
}

export function sendMessageBatch(body: Record<string, unknown>, store: SqsStore): unknown {
  const queueUrl = body.QueueUrl as string | undefined;
  if (!queueUrl) {
    throw new SqsError("InvalidParameterValue", "QueueUrl is required");
  }

  const queue = store.getQueue(queueUrl);
  if (!queue) {
    throw new SqsError("NonExistentQueue", "The specified queue does not exist.");
  }

  const entries = (body.Entries as BatchEntry[]) ?? [];
  if (entries.length === 0) {
    throw new SqsError("EmptyBatchRequest", "The batch request doesn't contain any entries.");
  }
  if (entries.length > 10) {
    throw new SqsError(
      "TooManyEntriesInBatchRequest",
      "Maximum number of entries per request are 10.",
    );
  }

  // Check for duplicate IDs
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.Id)) {
      throw new SqsError(
        "BatchEntryIdsNotDistinct",
        "Two or more batch entries in this request have the same Id.",
      );
    }
    ids.add(entry.Id);
  }

  const isFifo = queue.isFifo();
  const contentBasedDedup = queue.attributes.ContentBasedDeduplication === "true";

  const successful: Array<{
    Id: string;
    MessageId: string;
    MD5OfMessageBody: string;
    MD5OfMessageAttributes?: string;
    SequenceNumber?: string;
  }> = [];
  const failed: Array<{
    Id: string;
    SenderFault: boolean;
    Code: string;
    Message: string;
  }> = [];

  for (const entry of entries) {
    if (INVALID_MESSAGE_BODY_CHAR.test(entry.MessageBody)) {
      failed.push({
        Id: entry.Id,
        SenderFault: true,
        Code: "InvalidMessageContents",
        Message:
          "Invalid characters found. Valid unicode characters are #x9 | #xA | #xD | #x20 to #xD7FF and #xE000 to #xFFFD.",
      });
      continue;
    }

    const maxMessageSize = parseInt(queue.attributes.MaximumMessageSize);
    const totalSize = calculateMessageSize(entry.MessageBody, entry.MessageAttributes ?? {});
    if (totalSize > maxMessageSize) {
      failed.push({
        Id: entry.Id,
        SenderFault: true,
        Code: "InvalidParameterValue",
        Message: `One or more parameters are invalid. Reason: Message must be shorter than ${maxMessageSize} bytes.`,
      });
      continue;
    }

    if (isFifo) {
      // FIFO validations
      if (!entry.MessageGroupId) {
        failed.push({
          Id: entry.Id,
          SenderFault: true,
          Code: "MissingParameter",
          Message: "The request must contain the parameter MessageGroupId.",
        });
        continue;
      }

      if (entry.DelaySeconds !== undefined && entry.DelaySeconds !== 0) {
        failed.push({
          Id: entry.Id,
          SenderFault: true,
          Code: "InvalidParameterValue",
          Message: "DelaySeconds is not supported on FIFO queues.",
        });
        continue;
      }

      let dedupId = entry.MessageDeduplicationId;
      if (!dedupId) {
        if (contentBasedDedup) {
          dedupId = SqsStoreClass.contentBasedDeduplicationId(entry.MessageBody);
        } else {
          failed.push({
            Id: entry.Id,
            SenderFault: true,
            Code: "InvalidParameterValue",
            Message:
              "The queue should either have ContentBasedDeduplication enabled or MessageDeduplicationId provided explicitly.",
          });
          continue;
        }
      }

      // Check deduplication
      const dedupResult = queue.checkDeduplication(dedupId);
      if (dedupResult.isDuplicate) {
        const result: (typeof successful)[number] = {
          Id: entry.Id,
          MessageId: dedupResult.originalMessageId!,
          MD5OfMessageBody: md5(entry.MessageBody),
          SequenceNumber: dedupResult.originalSequenceNumber,
        };
        const attrsDigest = md5OfMessageAttributes(entry.MessageAttributes ?? {});
        if (attrsDigest) {
          result.MD5OfMessageAttributes = attrsDigest;
        }
        successful.push(result);
        continue;
      }

      const queueDelay = parseInt(queue.attributes.DelaySeconds);
      const msg = SqsStoreClass.createMessage(
        entry.MessageBody,
        entry.MessageAttributes ?? {},
        queueDelay > 0 ? queueDelay : undefined,
        entry.MessageGroupId,
        dedupId,
      );

      msg.sequenceNumber = queue.nextSequenceNumber();
      queue.recordDeduplication(dedupId, msg.messageId, msg.sequenceNumber);
      queue.enqueue(msg);

      const result: (typeof successful)[number] = {
        Id: entry.Id,
        MessageId: msg.messageId,
        MD5OfMessageBody: msg.md5OfBody,
        SequenceNumber: msg.sequenceNumber,
      };

      if (msg.md5OfMessageAttributes) {
        result.MD5OfMessageAttributes = msg.md5OfMessageAttributes;
      }

      successful.push(result);
    } else {
      // Standard queue
      const delaySeconds = entry.DelaySeconds ?? parseInt(queue.attributes.DelaySeconds);

      const msg = SqsStoreClass.createMessage(
        entry.MessageBody,
        entry.MessageAttributes ?? {},
        delaySeconds > 0 ? delaySeconds : undefined,
      );

      queue.enqueue(msg);

      const result: (typeof successful)[number] = {
        Id: entry.Id,
        MessageId: msg.messageId,
        MD5OfMessageBody: msg.md5OfBody,
      };

      if (msg.md5OfMessageAttributes) {
        result.MD5OfMessageAttributes = msg.md5OfMessageAttributes;
      }

      successful.push(result);
    }
  }

  return { Successful: successful, Failed: failed };
}
