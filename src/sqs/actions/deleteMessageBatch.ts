import { SqsError } from "../../common/errors.ts";
import type { SqsStore } from "../sqsStore.ts";

interface BatchEntry {
  Id: string;
  ReceiptHandle: string;
}

export function deleteMessageBatch(body: Record<string, unknown>, store: SqsStore): unknown {
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
    const deleted = queue.deleteMessage(entry.ReceiptHandle);
    if (deleted) {
      successful.push({ Id: entry.Id });
    } else {
      // AWS actually succeeds silently for invalid receipt handles on delete
      successful.push({ Id: entry.Id });
    }
  }

  return { Successful: successful, Failed: failed };
}
