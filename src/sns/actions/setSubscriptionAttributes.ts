import { SnsError } from "../../common/errors.ts";
import { snsSuccessResponse } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";
import { validateFilterPolicyLimits } from "../filter.ts";
import { validateSubscriptionRedrivePolicy } from "../subscriptionRedrivePolicy.ts";
import { setSubscriptionAttribute } from "../snsStore.ts";

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

  const attributeName = params.AttributeName;
  if (!attributeName) {
    throw new SnsError("InvalidParameter", "AttributeName is required");
  }

  const subscription = snsStore.getSubscription(subscriptionArn);
  if (!subscription) {
    throw new SnsError("NotFound", "Subscription does not exist", 404);
  }

  if (!VALID_SUBSCRIPTION_ATTRIBUTES.has(attributeName)) {
    throw new SnsError(
      "InvalidParameter",
      `Invalid parameter: AttributeName Reason: Invalid attribute name: ${attributeName}`,
    );
  }

  const attributeValue = resolveAttributeValue(attributeName, params.AttributeValue);
  if (attributeName === "FilterPolicy" && attributeValue) {
    validateFilterPolicyLimits(attributeValue);
  }
  if (attributeName === "RedrivePolicy" && attributeValue !== undefined) {
    validateSubscriptionRedrivePolicy(attributeValue);
  }
  setSubscriptionAttribute(subscription, attributeName, attributeValue);
  snsStore.persistence?.updateSubscriptionAttributes(subscriptionArn, subscription.attributes);

  return snsSuccessResponse("SetSubscriptionAttributes", "");
}

/**
 * Returns `undefined` when the call removes the attribute. AWS removes
 * RedrivePolicy only when AttributeValue is omitted (an empty string is
 * rejected), and removes FilterPolicy when it is set to an empty string.
 */
function resolveAttributeValue(
  attributeName: string,
  attributeValue: string | undefined,
): string | undefined {
  if (attributeName === "RedrivePolicy") return attributeValue;
  if (attributeName === "FilterPolicy" && !attributeValue) return undefined;

  return attributeValue ?? "";
}
