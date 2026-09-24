import type { CancelMessageMoveTaskResult } from "@aws-sdk/client-sqs";
import { SqsError } from "../../common/errors.ts";
import type { SqsStore } from "../sqsStore.ts";

/** Cancels a running message move task identified by its task handle. */
export function cancelMessageMoveTask(
  body: Record<string, unknown>,
  store: SqsStore,
): CancelMessageMoveTaskResult {
  const taskHandle = body.TaskHandle as string | undefined;
  if (!taskHandle) {
    throw new SqsError("InvalidParameterValue", "TaskHandle is required");
  }

  const moved = store.cancelMessageMoveTask(taskHandle);

  return { ApproximateNumberOfMessagesMoved: moved } satisfies CancelMessageMoveTaskResult;
}
