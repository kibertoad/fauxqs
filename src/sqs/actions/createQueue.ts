import type { FastifyRequest } from "fastify";
import { SqsError } from "../../common/errors.js";
import { sqsQueueArn } from "../../common/arnHelper.js";
import { DEFAULT_ACCOUNT_ID, DEFAULT_REGION } from "../../common/types.js";
import type { SqsStore } from "../sqsStore.js";
import { SETTABLE_ATTRIBUTES } from "../sqsTypes.js";

export function createQueue(
  body: Record<string, unknown>,
  store: SqsStore,
  request: FastifyRequest,
): unknown {
  const queueName = body.QueueName as string | undefined;
  if (!queueName) {
    throw new SqsError("InvalidParameterValue", "Queue name is required");
  }

  const attributes = (body.Attributes as Record<string, string>) ?? {};
  const tags = (body.tags as Record<string, string>) ?? {};

  // Check for existing queue with same name
  const existing = store.getQueueByName(queueName);
  if (existing) {
    // Idempotent: same name + same attributes = return existing
    // Different attributes = error
    for (const key of Object.keys(attributes)) {
      if (SETTABLE_ATTRIBUTES.has(key) && existing.attributes[key] !== attributes[key]) {
        throw new SqsError(
          "QueueNameExists",
          `A queue already exists with the same name and a different value for attribute ${key}`,
        );
      }
    }
    return { QueueUrl: existing.url };
  }

  const requestHost = request.headers.host ?? "localhost";
  const port = requestHost.includes(":") ? requestHost.split(":")[1] : "";
  const host = store.host
    ? `sqs.${DEFAULT_REGION}.${store.host}${port ? `:${port}` : ""}`
    : requestHost;
  const url = `http://${host}/${DEFAULT_ACCOUNT_ID}/${queueName}`;
  const arn = sqsQueueArn(queueName);

  const queue = store.createQueue(queueName, url, arn, attributes, tags);
  return { QueueUrl: queue.url };
}
