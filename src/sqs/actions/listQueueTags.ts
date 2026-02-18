import { SqsError } from "../../common/errors.js";
import type { SqsStore } from "../sqsStore.js";

export function listQueueTags(body: Record<string, unknown>, store: SqsStore): unknown {
  const queueUrl = body.QueueUrl as string | undefined;
  if (!queueUrl) {
    throw new SqsError("InvalidParameterValue", "QueueUrl is required");
  }

  const queue = store.getQueue(queueUrl);
  if (!queue) {
    throw new SqsError("NonExistentQueue", "The specified queue does not exist.");
  }

  return { Tags: Object.fromEntries(queue.tags) };
}
