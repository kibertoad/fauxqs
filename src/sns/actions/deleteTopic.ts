import { SnsError } from "../../common/errors.ts";
import { snsSuccessResponse } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";

export function deleteTopic(params: Record<string, string>, snsStore: SnsStore): string {
  const topicArn = params.TopicArn;
  if (!topicArn) {
    throw new SnsError("InvalidParameter", "TopicArn is required");
  }

  snsStore.deleteTopic(topicArn);
  return snsSuccessResponse("DeleteTopic", "");
}
