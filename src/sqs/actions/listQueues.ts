import type { SqsStore } from "../sqsStore.js";

export function listQueues(body: Record<string, unknown>, store: SqsStore): unknown {
  const prefix = body.QueueNamePrefix as string | undefined;
  const maxResults = body.MaxResults as number | undefined;
  const queues = store.listQueues(prefix ?? undefined, maxResults ?? undefined);

  return {
    QueueUrls: queues.map((q) => q.url),
  };
}
