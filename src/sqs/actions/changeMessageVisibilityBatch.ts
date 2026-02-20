import type {
  ChangeMessageVisibilityBatchResult,
  ChangeMessageVisibilityBatchResultEntry,
  BatchResultErrorEntry,
} from "@aws-sdk/client-sqs";
import { SqsError } from "../../common/errors.ts";
import type { SqsStore } from "../sqsStore.ts";
import { VALID_BATCH_ENTRY_ID } from "../sqsTypes.ts";

interface BatchEntry {
  Id: string;
  ReceiptHandle: string;
  VisibilityTimeout: number;
}

export function changeMessageVisibilityBatch(
  body: Record<string, unknown>,
  store: SqsStore,
): ChangeMessageVisibilityBatchResult {
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

  // Validate entry IDs
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!VALID_BATCH_ENTRY_ID.test(entry.Id)) {
      throw new SqsError(
        "InvalidBatchEntryId",
        "A batch entry id can only contain alphanumeric characters, hyphens and underscores. It can be at most 80 letters long.",
      );
    }
    if (ids.has(entry.Id)) {
      throw new SqsError(
        "BatchEntryIdsNotDistinct",
        "Two or more batch entries in the request have the same Id.",
      );
    }
    ids.add(entry.Id);
  }

  const successful: ChangeMessageVisibilityBatchResultEntry[] = [];
  const failed: BatchResultErrorEntry[] = [];

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

  return { Successful: successful, Failed: failed } satisfies ChangeMessageVisibilityBatchResult;
}
