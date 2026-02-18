import { SnsError } from "../../common/errors.js";
import { snsSuccessResponse } from "../../common/xml.js";
import type { SnsStore } from "../snsStore.js";

export function deleteTopic(params: Record<string, string>, snsStore: SnsStore): string {
  const topicArn = params.TopicArn;
  if (!topicArn) {
    throw new SnsError("InvalidParameter", "TopicArn is required");
  }

  snsStore.deleteTopic(topicArn);
  return snsSuccessResponse("DeleteTopic", "");
}
