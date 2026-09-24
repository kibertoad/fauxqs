import { SqsError, QueueDoesNotExistError } from "../../common/errors.ts";
import type { SqsStore } from "../sqsStore.ts";

export async function untagQueue(body: Record<string, unknown>, store: SqsStore): Promise<unknown> {
  const queueUrl = body.QueueUrl as string | undefined;
  if (!queueUrl) {
    throw new SqsError("InvalidParameterValue", "QueueUrl is required");
  }

  const queue = store.getQueue(queueUrl);
  if (!queue) {
    throw new QueueDoesNotExistError();
  }

  const tagKeys = (body.TagKeys as string[]) ?? [];
  for (const key of tagKeys) {
    queue.tags.delete(key);
  }

  await queue.persistence?.insertQueue(queue);

  return {};
}
