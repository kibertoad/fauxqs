import type { ListDeadLetterSourceQueuesResult } from "@aws-sdk/client-sqs";
import { SqsError, QueueDoesNotExistError } from "../../common/errors.ts";
import type { SqsStore } from "../sqsStore.ts";

/**
 * Returns the URLs of the queues that have the given queue configured as their
 * dead-letter queue (via RedrivePolicy.deadLetterTargetArn).
 */
export function listDeadLetterSourceQueues(
  body: Record<string, unknown>,
  store: SqsStore,
): ListDeadLetterSourceQueuesResult {
  const queueUrl = body.QueueUrl as string | undefined;
  if (!queueUrl) {
    throw new SqsError("InvalidParameterValue", "QueueUrl is required");
  }

  const dlq = store.getQueue(queueUrl);
  if (!dlq) {
    throw new QueueDoesNotExistError();
  }

  let maxResults: number | undefined;
  if (body.MaxResults !== undefined) {
    const parsed = Number(body.MaxResults);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
      throw new SqsError(
        "InvalidParameterValue",
        "MaxResults must be an integer between 1 and 1000",
      );
    }
    maxResults = parsed;
  }
  const nextToken = body.NextToken as string | undefined;

  // Sort with default (UTF-16 code-unit) ordering so it stays consistent with
  // the `u > nextToken` cursor comparison below. A locale-aware sort can order
  // mixed-case names differently from `>` and silently drop queues at a page
  // boundary.
  let urls = store
    .deadLetterSourceQueues(dlq.arn)
    .map((q) => q.url)
    .sort();

  if (nextToken) {
    urls = urls.filter((u) => u > nextToken);
  }

  let resultNextToken: string | undefined;
  if (maxResults && urls.length > maxResults) {
    urls = urls.slice(0, maxResults);
    resultNextToken = urls[urls.length - 1];
  }

  return {
    queueUrls: urls,
    ...(resultNextToken ? { NextToken: resultNextToken } : {}),
  } satisfies ListDeadLetterSourceQueuesResult;
}
