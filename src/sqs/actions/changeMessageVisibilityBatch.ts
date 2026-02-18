import { SqsError } from "../../common/errors.js";
import type { SqsStore } from "../sqsStore.js";

interface BatchEntry {
  Id: string;
  ReceiptHandle: string;
  VisibilityTimeout: number;
}

export function changeMessageVisibilityBatch(
  body: Record<string, unknown>,
  store: SqsStore,
): unknown {
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

  const successful: Array<{ Id: string }> = [];
  const failed: Array<{
    Id: string;
    SenderFault: boolean;
    Code: string;
    Message: string;
  }> = [];

  for (const entry of entries) {
    if (!queue.inflightMessages.has(entry.ReceiptHandle)) {
      failed.push({
        Id: entry.Id,
        SenderFault: true,
        Code: "ReceiptHandleIsInvalid",
        Message: "The input receipt handle is invalid.",
      });
    } else {
      queue.changeVisibility(entry.ReceiptHandle, entry.VisibilityTimeout);
      successful.push({ Id: entry.Id });
    }
  }

  return { Successful: successful, Failed: failed };
}
