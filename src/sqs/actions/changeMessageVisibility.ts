import { SqsError } from "../../common/errors.ts";
import type { SqsStore } from "../sqsStore.ts";

export function changeMessageVisibility(body: Record<string, unknown>, store: SqsStore): unknown {
  const queueUrl = body.QueueUrl as string | undefined;
  if (!queueUrl) {
    throw new SqsError("InvalidParameterValue", "QueueUrl is required");
  }

  const queue = store.getQueue(queueUrl);
  if (!queue) {
    throw new SqsError("NonExistentQueue", "The specified queue does not exist.");
  }

  const receiptHandle = body.ReceiptHandle as string | undefined;
  if (!receiptHandle) {
    throw new SqsError("MissingParameter", "The request must contain the parameter ReceiptHandle.");
  }

  const visibilityTimeout = body.VisibilityTimeout as number | undefined;
  if (visibilityTimeout === undefined) {
    throw new SqsError(
      "MissingParameter",
      "The request must contain the parameter VisibilityTimeout.",
    );
  }

  if (visibilityTimeout < 0 || visibilityTimeout > 43200) {
    throw new SqsError(
      "InvalidParameterValue",
      `Value ${visibilityTimeout} for parameter VisibilityTimeout is invalid. Reason: Must be between 0 and 43200.`,
    );
  }

  if (!queue.inflightMessages.has(receiptHandle)) {
    throw new SqsError(
      "MessageNotInflight",
      "Message does not exist or is not available for visibility timeout change.",
    );
  }

  queue.changeVisibility(receiptHandle, visibilityTimeout);
  return {};
}
