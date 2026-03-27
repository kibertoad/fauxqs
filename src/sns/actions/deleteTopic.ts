import { SnsError } from "../../common/errors.ts";
import { snsSuccessResponse } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";

export async function deleteTopic(
  params: Record<string, string>,
  snsStore: SnsStore,
): Promise<string> {
  const topicArn = params.TopicArn;
  if (!topicArn) {
    throw new SnsError("InvalidParameter", "TopicArn is required");
  }

  await snsStore.deleteTopic(topicArn);
  return snsSuccessResponse("DeleteTopic", "");
}
