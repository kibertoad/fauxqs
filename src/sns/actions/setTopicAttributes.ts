import { SnsError } from "../../common/errors.ts";
import { snsSuccessResponse } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";

export function setTopicAttributes(params: Record<string, string>, snsStore: SnsStore): string {
  const topicArn = params.TopicArn;
  if (!topicArn) {
    throw new SnsError("InvalidParameter", "TopicArn is required");
  }

  const topic = snsStore.getTopic(topicArn);
  if (!topic) {
    throw new SnsError("NotFound", "Topic does not exist", 404);
  }

  const attributeName = params.AttributeName;
  const attributeValue = params.AttributeValue ?? "";

  if (attributeName) {
    topic.attributes[attributeName] = attributeValue;
  }

  return snsSuccessResponse("SetTopicAttributes", "");
}
