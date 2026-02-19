import { SnsError } from "../../common/errors.ts";
import { snsSuccessResponse } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";

const VALID_SUBSCRIPTION_ATTRIBUTES = new Set([
  "RawMessageDelivery",
  "FilterPolicy",
  "FilterPolicyScope",
  "RedrivePolicy",
  "DeliveryPolicy",
  "SubscriptionRoleArn",
]);

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
    if (!VALID_SUBSCRIPTION_ATTRIBUTES.has(attributeName)) {
      throw new SnsError(
        "InvalidParameter",
        `Invalid parameter: AttributeName Reason: Invalid attribute name: ${attributeName}`,
      );
    }
    subscription.attributes[attributeName] = attributeValue;
  }

  return snsSuccessResponse("SetSubscriptionAttributes", "");
}
