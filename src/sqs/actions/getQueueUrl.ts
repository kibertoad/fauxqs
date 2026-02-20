import type { FastifyRequest } from "fastify";
import type { GetQueueUrlResult } from "@aws-sdk/client-sqs";
import { SqsError, QueueDoesNotExistError } from "../../common/errors.ts";
import { sqsQueueArn } from "../../common/arnHelper.ts";
import { DEFAULT_REGION, regionFromAuth } from "../../common/types.ts";
import type { SqsStore } from "../sqsStore.ts";

export function getQueueUrl(
  body: Record<string, unknown>,
  store: SqsStore,
  request: FastifyRequest,
): GetQueueUrlResult {
  const queueName = body.QueueName as string | undefined;
  if (!queueName) {
    throw new SqsError("InvalidParameterValue", "QueueName is required");
  }

  const region = regionFromAuth(request.headers.authorization) ?? store.region ?? DEFAULT_REGION;
  const arn = sqsQueueArn(queueName, region);
  const queue = store.getQueueByArn(arn);
  if (!queue) {
    throw new QueueDoesNotExistError();
  }

  return { QueueUrl: queue.url } satisfies GetQueueUrlResult;
}
