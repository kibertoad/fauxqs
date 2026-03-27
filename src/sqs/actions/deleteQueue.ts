import { SqsError, QueueDoesNotExistError } from "../../common/errors.ts";
import type { SqsStore } from "../sqsStore.ts";

export async function deleteQueue(
  body: Record<string, unknown>,
  store: SqsStore,
): Promise<unknown> {
  const queueUrl = body.QueueUrl as string | undefined;
  if (!queueUrl) {
    throw new SqsError("InvalidParameterValue", "QueueUrl is required");
  }

  const deleted = await store.deleteQueue(queueUrl);
  if (!deleted) {
    throw new QueueDoesNotExistError();
  }

  return {};
}
