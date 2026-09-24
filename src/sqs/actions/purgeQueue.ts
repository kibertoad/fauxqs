import { SqsError, QueueDoesNotExistError } from "../../common/errors.ts";
import type { SqsStore } from "../sqsStore.ts";

export async function purgeQueue(body: Record<string, unknown>, store: SqsStore): Promise<unknown> {
  const queueUrl = body.QueueUrl as string | undefined;
  if (!queueUrl) {
    throw new SqsError("InvalidParameterValue", "QueueUrl is required");
  }

  const queue = store.getQueue(queueUrl);
  if (!queue) {
    throw new QueueDoesNotExistError();
  }

  await queue.purge();
  return {};
}
