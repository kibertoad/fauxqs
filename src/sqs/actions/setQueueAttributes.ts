import { SqsError, QueueDoesNotExistError } from "../../common/errors.ts";
import type { SqsStore } from "../sqsStore.ts";
import { SETTABLE_ATTRIBUTES, validateQueueAttributes } from "../sqsTypes.ts";

export function setQueueAttributes(body: Record<string, unknown>, store: SqsStore): unknown {
  const queueUrl = body.QueueUrl as string | undefined;
  if (!queueUrl) {
    throw new SqsError("InvalidParameterValue", "QueueUrl is required");
  }

  const queue = store.getQueue(queueUrl);
  if (!queue) {
    throw new QueueDoesNotExistError();
  }

  const attributes = (body.Attributes as Record<string, string>) ?? {};

  for (const key of Object.keys(attributes)) {
    if (!SETTABLE_ATTRIBUTES.has(key)) {
      throw new SqsError("InvalidAttributeName", `Unknown attribute: ${key}`);
    }
  }

  // Validate attribute ranges
  validateQueueAttributes(attributes, SqsError);

  // FifoQueue cannot be changed after creation
  if (attributes.FifoQueue !== undefined && attributes.FifoQueue !== queue.attributes.FifoQueue) {
    throw new SqsError(
      "InvalidAttributeValue",
      "Invalid value for the parameter FifoQueue. You cannot change the FifoQueue attribute of an existing queue.",
    );
  }

  queue.setAttributes(attributes);
  return {};
}
