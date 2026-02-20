import type { FastifyRequest } from "fastify";
import type { CreateQueueResult } from "@aws-sdk/client-sqs";
import { SqsError } from "../../common/errors.ts";
import { sqsQueueArn } from "../../common/arnHelper.ts";
import { DEFAULT_REGION, regionFromAuth } from "../../common/types.ts";
import type { SqsStore } from "../sqsStore.ts";
import { SETTABLE_ATTRIBUTES, validateQueueAttributes } from "../sqsTypes.ts";

export function createQueue(
  body: Record<string, unknown>,
  store: SqsStore,
  request: FastifyRequest,
): CreateQueueResult {
  const queueName = body.QueueName as string | undefined;
  if (!queueName) {
    throw new SqsError("InvalidParameterValue", "Queue name is required");
  }

  const attributes = (body.Attributes as Record<string, string>) ?? {};
  const tags = (body.tags as Record<string, string>) ?? {};

  // FIFO validation
  const isFifoName = queueName.endsWith(".fifo");
  const isFifoAttr = attributes.FifoQueue === "true";

  if (isFifoName && !isFifoAttr) {
    // Auto-set FifoQueue when name ends with .fifo
    attributes.FifoQueue = "true";
  } else if (isFifoAttr && !isFifoName) {
    throw new SqsError(
      "InvalidParameterValue",
      "The name of a FIFO queue can only include alphanumeric characters, hyphens, or underscores, must end with .fifo suffix.",
    );
  }

  // Set FIFO defaults
  if (attributes.FifoQueue === "true") {
    if (attributes.ContentBasedDeduplication === undefined) {
      attributes.ContentBasedDeduplication = "false";
    }
    if (attributes.DeduplicationScope === undefined) {
      attributes.DeduplicationScope = "queue";
    }
    if (attributes.FifoThroughputLimit === undefined) {
      attributes.FifoThroughputLimit = "perQueue";
    }
  }

  // Validate attribute ranges
  validateQueueAttributes(attributes, SqsError);

  const region = regionFromAuth(request.headers.authorization) ?? store.region ?? DEFAULT_REGION;

  // Check for existing queue with same name in the same region (idempotency)
  const arn = sqsQueueArn(queueName, region);
  const existing = store.getQueueByArn(arn);
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
    return { QueueUrl: existing.url } satisfies CreateQueueResult;
  }

  const requestHost = request.headers.host ?? "localhost";
  const port = requestHost.includes(":") ? requestHost.split(":")[1] : "";
  const url = store.buildQueueUrl(queueName, port, requestHost, region);

  const queue = store.createQueue(queueName, url, arn, attributes, tags);
  return { QueueUrl: queue.url } satisfies CreateQueueResult;
}
