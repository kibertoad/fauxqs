import { SqsError } from "../../common/errors.js";
import type { SqsStore } from "../sqsStore.js";

export function getQueueAttributes(
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
      400,
    );
  }

  const attributeNames = (body.AttributeNames as string[]) ?? ["All"];
  const attributes = queue.getAllAttributes(attributeNames);

  return { Attributes: attributes };
}
