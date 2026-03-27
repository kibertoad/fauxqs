import { SnsError } from "../../common/errors.ts";
import { snsSuccessResponse } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";
import { validateFilterPolicyLimits } from "../filter.ts";

const VALID_SUBSCRIPTION_ATTRIBUTES = new Set([
  "RawMessageDelivery",
  "FilterPolicy",
  "FilterPolicyScope",
  "RedrivePolicy",
  "DeliveryPolicy",
  "SubscriptionRoleArn",
]);

export async function setSubscriptionAttributes(
  params: Record<string, string>,
  snsStore: SnsStore,
): Promise<string> {
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
    if (attributeName === "FilterPolicy" && attributeValue) {
      validateFilterPolicyLimits(attributeValue);
    }
    subscription.attributes[attributeName] = attributeValue;
    // Invalidate cached parsed filter policy when relevant attributes change
    if (attributeName === "FilterPolicy" || attributeName === "FilterPolicyScope") {
      subscription.parsedFilterPolicy = undefined;
    }
    await snsStore.persistence?.updateSubscriptionAttributes(
      subscriptionArn,
      subscription.attributes,
    );
  }

  return snsSuccessResponse("SetSubscriptionAttributes", "");
}
