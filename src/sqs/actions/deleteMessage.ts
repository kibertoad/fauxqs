import { SqsError, QueueDoesNotExistError } from "../../common/errors.ts";
import type { SqsStore } from "../sqsStore.ts";

export function deleteMessage(body: Record<string, unknown>, store: SqsStore): unknown {
  const queueUrl = body.QueueUrl as string | undefined;
  if (!queueUrl) {
    throw new SqsError("InvalidParameterValue", "QueueUrl is required");
  }

  const queue = store.getQueue(queueUrl);
  if (!queue) {
    throw new QueueDoesNotExistError();
  }

  const receiptHandle = body.ReceiptHandle as string | undefined;
  if (!receiptHandle) {
    throw new SqsError("MissingParameter", "The request must contain the parameter ReceiptHandle.");
  }

  // AWS doesn't error if the receipt handle is invalid/already deleted
  queue.deleteMessage(receiptHandle);

  return {};
}
