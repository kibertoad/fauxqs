import type {
  ListMessageMoveTasksResult,
  ListMessageMoveTasksResultEntry,
} from "@aws-sdk/client-sqs";
import { SqsError } from "../../common/errors.ts";
import type { SqsStore } from "../sqsStore.ts";

/** Lists the most recent message move tasks for a source dead-letter queue. */
export function listMessageMoveTasks(
  body: Record<string, unknown>,
  store: SqsStore,
): ListMessageMoveTasksResult {
  const sourceArn = body.SourceArn as string | undefined;
  if (!sourceArn) {
    throw new SqsError("InvalidParameterValue", "SourceArn is required");
  }

  if (!store.getQueueByArn(sourceArn)) {
    throw new SqsError(
      "ResourceNotFoundException",
      "The resource that you specified for the SourceArn parameter doesn't exist.",
      404,
    );
  }

  // AWS allows MaxResults in the range 1–10, defaulting to 1.
  const requestedMaxResults = (body.MaxResults as number | undefined) ?? 1;
  const maxResults = Math.min(10, Math.max(1, Math.trunc(requestedMaxResults) || 1));
  const tasks = store.listMessageMoveTasks(sourceArn, maxResults);

  const results: ListMessageMoveTasksResultEntry[] = tasks.map((task) => ({
    // AWS only returns a TaskHandle for RUNNING tasks (the cancellable ones).
    ...(task.status === "RUNNING" ? { TaskHandle: task.taskHandle } : {}),
    Status: task.status,
    SourceArn: task.sourceArn,
    ...(task.destinationArn ? { DestinationArn: task.destinationArn } : {}),
    ...(task.maxNumberOfMessagesPerSecond !== undefined
      ? { MaxNumberOfMessagesPerSecond: task.maxNumberOfMessagesPerSecond }
      : {}),
    ApproximateNumberOfMessagesMoved: task.approximateNumberOfMessagesMoved,
    ApproximateNumberOfMessagesToMove: task.approximateNumberOfMessagesToMove,
    ...(task.failureReason ? { FailureReason: task.failureReason } : {}),
    StartedTimestamp: task.startedTimestamp,
  }));

  return { Results: results } satisfies ListMessageMoveTasksResult;
}
