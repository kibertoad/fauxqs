import type { GetQueueAttributesResult } from "@aws-sdk/client-sqs";
import { SqsError, QueueDoesNotExistError } from "../../common/errors.ts";
import type { SqsStore } from "../sqsStore.ts";

export function getQueueAttributes(
  body: Record<string, unknown>,
  store: SqsStore,
): GetQueueAttributesResult {
  const queueUrl = body.QueueUrl as string | undefined;
  if (!queueUrl) {
    throw new SqsError("InvalidParameterValue", "QueueUrl is required");
  }

  const queue = store.getQueue(queueUrl);
  if (!queue) {
    throw new QueueDoesNotExistError();
  }

  const attributeNames = (body.AttributeNames as string[]) ?? ["All"];
  const attributes = queue.getAllAttributes(attributeNames);

  return { Attributes: attributes } satisfies GetQueueAttributesResult;
}
