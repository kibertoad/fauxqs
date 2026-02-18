import { SqsError } from "../../common/errors.js";
import type { SqsStore } from "../sqsStore.js";
import { SqsStore as SqsStoreClass } from "../sqsStore.js";
import type { MessageAttributeValue } from "../sqsTypes.js";

interface BatchEntry {
  Id: string;
  MessageBody: string;
  DelaySeconds?: number;
  MessageAttributes?: Record<string, MessageAttributeValue>;
}

export function sendMessageBatch(
  body: Record<string, unknown>,
  store: SqsStore,
): unknown {
  const queueUrl = body.QueueUrl as string | undefined;
  if (!queueUrl) {
    throw new SqsError("InvalidParameterValue", "QueueUrl is required");
  }

  const queue = store.getQueue(queueUrl);
  if (!queue) {
    throw new SqsError(
      "NonExistentQueue",
      "The specified queue does not exist.",
    );
  }

  const entries = (body.Entries as BatchEntry[]) ?? [];
  if (entries.length === 0) {
    throw new SqsError(
      "EmptyBatchRequest",
      "The batch request doesn't contain any entries.",
    );
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

  const successful: Array<{
    Id: string;
    MessageId: string;
    MD5OfMessageBody: string;
    MD5OfMessageAttributes?: string;
  }> = [];

  for (const entry of entries) {
    const delaySeconds =
      entry.DelaySeconds ?? parseInt(queue.attributes.DelaySeconds);

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

  return { Successful: successful, Failed: [] };
}
