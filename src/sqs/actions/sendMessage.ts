import { SqsError } from "../../common/errors.js";
import type { SqsStore } from "../sqsStore.js";
import { SqsStore as SqsStoreClass } from "../sqsStore.js";
import type { MessageAttributeValue } from "../sqsTypes.js";

export function sendMessage(
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

  const messageBody = body.MessageBody as string | undefined;
  if (!messageBody) {
    throw new SqsError(
      "MissingParameter",
      "The request must contain the parameter MessageBody.",
    );
  }

  const messageAttributes =
    (body.MessageAttributes as Record<string, MessageAttributeValue>) ?? {};

  // DelaySeconds: per-message override or queue default
  const delaySeconds =
    (body.DelaySeconds as number | undefined) ??
    parseInt(queue.attributes.DelaySeconds);

  const msg = SqsStoreClass.createMessage(
    messageBody,
    messageAttributes,
    delaySeconds > 0 ? delaySeconds : undefined,
  );

  queue.enqueue(msg);

  const result: Record<string, unknown> = {
    MessageId: msg.messageId,
    MD5OfMessageBody: msg.md5OfBody,
  };

  if (msg.md5OfMessageAttributes) {
    result.MD5OfMessageAttributes = msg.md5OfMessageAttributes;
  }

  return result;
}
