import type { ListQueuesResult } from "@aws-sdk/client-sqs";
import type { SqsStore } from "../sqsStore.ts";

export function listQueues(body: Record<string, unknown>, store: SqsStore): ListQueuesResult {
  const prefix = body.QueueNamePrefix as string | undefined;
  const maxResults = body.MaxResults as number | undefined;
  const nextToken = body.NextToken as string | undefined;
  const result = store.listQueues(prefix ?? undefined, maxResults ?? undefined, nextToken ?? undefined);

  return {
    QueueUrls: result.queues.map((q) => q.url),
    ...(result.nextToken ? { NextToken: result.nextToken } : {}),
  } satisfies ListQueuesResult;
}
