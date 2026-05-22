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

  const maxResults = body.MaxResults as number | undefined;
  const nextToken = body.NextToken as string | undefined;

  let urls = store
    .deadLetterSourceQueues(dlq.arn)
    .map((q) => q.url)
    .sort((a, b) => a.localeCompare(b));

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
