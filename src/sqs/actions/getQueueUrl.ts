import { SqsError } from "../../common/errors.js";
import type { SqsStore } from "../sqsStore.js";

export function getQueueUrl(body: Record<string, unknown>, store: SqsStore): unknown {
  const queueName = body.QueueName as string | undefined;
  if (!queueName) {
    throw new SqsError("InvalidParameterValue", "QueueName is required");
  }

  const queue = store.getQueueByName(queueName);
  if (!queue) {
    throw new SqsError("NonExistentQueue", "The specified queue does not exist.", 400);
  }

  return { QueueUrl: queue.url };
}
