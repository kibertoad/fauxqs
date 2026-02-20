import type { FastifyRequest } from "fastify";
import type { CreateTopicResponse } from "@aws-sdk/client-sns";
import { SnsError } from "../../common/errors.ts";
import { DEFAULT_REGION, regionFromAuth } from "../../common/types.ts";
import { snsSuccessResponse } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";
import type { SqsStore } from "../../sqs/sqsStore.ts";

export function createTopic(
  params: Record<string, string>,
  snsStore: SnsStore,
  _sqsStore: SqsStore,
  request: FastifyRequest,
): string {
  const name = params.Name;
  if (!name) {
    throw new SnsError("InvalidParameter", "Topic name is required");
  }

  const attributes: Record<string, string> = {};
  const tags: Record<string, string> = {};

  // Parse Attributes.entry.N.key/value
  for (const [key, value] of Object.entries(params)) {
    const attrMatch = key.match(/^Attributes\.entry\.(\d+)\.(key|value)$/);
    if (attrMatch) {
      const idx = attrMatch[1];
      const field = attrMatch[2];
      if (field === "key") {
        attributes[`__key_${idx}`] = value;
      } else {
        attributes[`__val_${idx}`] = value;
      }
    }
    const tagMatch = key.match(/^Tags\.member\.(\d+)\.(Key|Value)$/);
    if (tagMatch) {
      const idx = tagMatch[1];
      const field = tagMatch[2];
      if (field === "Key") {
        tags[`__key_${idx}`] = value;
      } else {
        tags[`__val_${idx}`] = value;
      }
    }
  }

  // Resolve indexed attributes
  const resolvedAttributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith("__key_")) {
      const idx = key.slice(6);
      const val = attributes[`__val_${idx}`];
      if (val !== undefined) {
        resolvedAttributes[value] = val;
      }
    }
  }

  const resolvedTags: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (key.startsWith("__key_")) {
      const idx = key.slice(6);
      const val = tags[`__val_${idx}`];
      if (val !== undefined) {
        resolvedTags[value] = val;
      }
    }
  }

  // FIFO topic validation
  const isFifoName = name.endsWith(".fifo");
  const isFifoAttr = resolvedAttributes.FifoTopic === "true";

  if (isFifoName && !isFifoAttr) {
    resolvedAttributes.FifoTopic = "true";
  } else if (isFifoAttr && !isFifoName) {
    throw new SnsError(
      "InvalidParameter",
      "Invalid parameter: Fifo Topic names must end with .fifo suffix",
    );
  }

  if (resolvedAttributes.FifoTopic === "true") {
    if (resolvedAttributes.ContentBasedDeduplication === undefined) {
      resolvedAttributes.ContentBasedDeduplication = "false";
    }
  }

  const region = regionFromAuth(request.headers.authorization) ?? snsStore.region ?? DEFAULT_REGION;
  const topic = snsStore.createTopic(
    name,
    Object.keys(resolvedAttributes).length > 0 ? resolvedAttributes : undefined,
    Object.keys(resolvedTags).length > 0 ? resolvedTags : undefined,
    region,
  );

  const result = { TopicArn: topic.arn } satisfies CreateTopicResponse;
  return snsSuccessResponse("CreateTopic", `<TopicArn>${result.TopicArn}</TopicArn>`);
}
