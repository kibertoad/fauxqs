import { SnsError } from "../../common/errors.js";
import { snsSuccessResponse } from "../../common/xml.js";
import type { SnsStore } from "../snsStore.js";

export function unsubscribe(params: Record<string, string>, snsStore: SnsStore): string {
  const subscriptionArn = params.SubscriptionArn;
  if (!subscriptionArn) {
    throw new SnsError("InvalidParameter", "SubscriptionArn is required");
  }

  snsStore.unsubscribe(subscriptionArn);
  return snsSuccessResponse("Unsubscribe", "");
}
