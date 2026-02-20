import type { GetQueueUrlResult } from "@aws-sdk/client-sqs";
import { SqsError } from "../../common/errors.ts";
import type { SqsStore } from "../sqsStore.ts";

export function getQueueUrl(body: Record<string, unknown>, store: SqsStore): GetQueueUrlResult {
  const queueName = body.QueueName as string | undefined;
  if (!queueName) {
    throw new SqsError("InvalidParameterValue", "QueueName is required");
  }

  const queue = store.getQueueByName(queueName);
  if (!queue) {
    throw new SqsError("NonExistentQueue", "The specified queue does not exist.", 400);
  }

  return { QueueUrl: queue.url } satisfies GetQueueUrlResult;
}
