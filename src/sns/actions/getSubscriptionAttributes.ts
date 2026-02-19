import { SnsError } from "../../common/errors.ts";
import { snsSuccessResponse, escapeXml } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";

export function getSubscriptionAttributes(
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

  const allAttributes: Record<string, string> = {
    SubscriptionArn: subscription.arn,
    TopicArn: subscription.topicArn,
    Protocol: subscription.protocol,
    Endpoint: subscription.endpoint,
    Owner: "000000000000",
    ConfirmationWasAuthenticated: "true",
    PendingConfirmation: subscription.confirmed ? "false" : "true",
    SubscriptionPrincipal: "arn:aws:iam::000000000000:user/local",
    RawMessageDelivery: subscription.attributes.RawMessageDelivery ?? "false",
    ...subscription.attributes,
  };

  const entriesXml = Object.entries(allAttributes)
    .map(
      ([key, value]) =>
        `<entry><key>${escapeXml(key)}</key><value>${escapeXml(value)}</value></entry>`,
    )
    .join("\n    ");

  return snsSuccessResponse("GetSubscriptionAttributes", `<Attributes>${entriesXml}</Attributes>`);
}
