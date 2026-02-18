import { SqsError } from "../../common/errors.js";
import type { SqsStore } from "../sqsStore.js";

export function deleteMessage(body: Record<string, unknown>, store: SqsStore): unknown {
  const queueUrl = body.QueueUrl as string | undefined;
  if (!queueUrl) {
    throw new SqsError("InvalidParameterValue", "QueueUrl is required");
  }

  const queue = store.getQueue(queueUrl);
  if (!queue) {
    throw new SqsError("NonExistentQueue", "The specified queue does not exist.", 400);
  }

  const receiptHandle = body.ReceiptHandle as string | undefined;
  if (!receiptHandle) {
    throw new SqsError("MissingParameter", "The request must contain the parameter ReceiptHandle.");
  }

  // AWS doesn't error if the receipt handle is invalid/already deleted
  queue.deleteMessage(receiptHandle);

  return {};
}
