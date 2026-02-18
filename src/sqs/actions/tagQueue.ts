import { SqsError } from "../../common/errors.js";
import type { SqsStore } from "../sqsStore.js";

export function tagQueue(
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

  const tags = (body.Tags as Record<string, string>) ?? {};
  for (const [key, value] of Object.entries(tags)) {
    queue.tags.set(key, value);
  }

  return {};
}
