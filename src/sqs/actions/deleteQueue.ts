import { SqsError } from "../../common/errors.js";
import type { SqsStore } from "../sqsStore.js";

export function deleteQueue(
  body: Record<string, unknown>,
  store: SqsStore,
): unknown {
  const queueUrl = body.QueueUrl as string | undefined;
  if (!queueUrl) {
    throw new SqsError("InvalidParameterValue", "QueueUrl is required");
  }

  const deleted = store.deleteQueue(queueUrl);
  if (!deleted) {
    throw new SqsError(
      "NonExistentQueue",
      "The specified queue does not exist.",
      400,
    );
  }

  return {};
}
