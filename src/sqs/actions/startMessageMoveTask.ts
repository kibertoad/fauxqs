import type { StartMessageMoveTaskResult } from "@aws-sdk/client-sqs";
import { SqsError } from "../../common/errors.ts";
import type { SqsStore } from "../sqsStore.ts";

/**
 * Starts a task to redrive messages from a dead-letter queue. When
 * DestinationArn is omitted, each message is moved back to the queue it
 * originally came from.
 */
export function startMessageMoveTask(
  body: Record<string, unknown>,
  store: SqsStore,
): StartMessageMoveTaskResult {
  const sourceArn = body.SourceArn as string | undefined;
  if (!sourceArn) {
    throw new SqsError("InvalidParameterValue", "SourceArn is required");
  }

  const destinationArn = body.DestinationArn as string | undefined;
  const maxNumberOfMessagesPerSecond = body.MaxNumberOfMessagesPerSecond as number | undefined;
  if (
    maxNumberOfMessagesPerSecond !== undefined &&
    (!Number.isInteger(maxNumberOfMessagesPerSecond) ||
      maxNumberOfMessagesPerSecond < 1 ||
      maxNumberOfMessagesPerSecond > 500)
  ) {
    throw new SqsError(
      "InvalidParameterValue",
      "MaxNumberOfMessagesPerSecond must be an integer between 1 and 500.",
    );
  }

  const task = store.startMessageMoveTask(sourceArn, destinationArn, maxNumberOfMessagesPerSecond);

  return { TaskHandle: task.taskHandle } satisfies StartMessageMoveTaskResult;
}
