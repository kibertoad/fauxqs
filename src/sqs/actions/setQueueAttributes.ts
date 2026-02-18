import { SqsError } from "../../common/errors.js";
import type { SqsStore } from "../sqsStore.js";
import { SETTABLE_ATTRIBUTES } from "../sqsTypes.js";

export function setQueueAttributes(body: Record<string, unknown>, store: SqsStore): unknown {
  const queueUrl = body.QueueUrl as string | undefined;
  if (!queueUrl) {
    throw new SqsError("InvalidParameterValue", "QueueUrl is required");
  }

  const queue = store.getQueue(queueUrl);
  if (!queue) {
    throw new SqsError("NonExistentQueue", "The specified queue does not exist.", 400);
  }

  const attributes = (body.Attributes as Record<string, string>) ?? {};

  for (const key of Object.keys(attributes)) {
    if (!SETTABLE_ATTRIBUTES.has(key)) {
      throw new SqsError("InvalidAttributeName", `Unknown attribute: ${key}`);
    }
  }

  queue.setAttributes(attributes);
  return {};
}
