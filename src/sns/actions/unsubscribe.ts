import { SnsError } from "../../common/errors.ts";
import { snsSuccessResponse } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";

export function unsubscribe(params: Record<string, string>, snsStore: SnsStore): string {
  const subscriptionArn = params.SubscriptionArn;
  if (!subscriptionArn) {
    throw new SnsError("InvalidParameter", "SubscriptionArn is required");
  }

  snsStore.unsubscribe(subscriptionArn);
  return snsSuccessResponse("Unsubscribe", "");
}
