import { SnsError } from "../../common/errors.js";
import { snsSuccessResponse } from "../../common/xml.js";
import type { SnsStore } from "../snsStore.js";

export function setSubscriptionAttributes(
  params: Record<string, string>,
  snsStore: SnsStore,
): string {
  const subscriptionArn = params.SubscriptionArn;
  if (!subscriptionArn) {
    throw new SnsError("InvalidParameter", "SubscriptionArn is required");
  }

  const subscription = snsStore.getSubscription(subscriptionArn);
  if (!subscription) {
    throw new SnsError("NotFound", "Subscription does not exist", 404);
  }

  const attributeName = params.AttributeName;
  const attributeValue = params.AttributeValue ?? "";

  if (attributeName) {
    subscription.attributes[attributeName] = attributeValue;
  }

  return snsSuccessResponse("SetSubscriptionAttributes", "");
}
