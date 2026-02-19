import { SnsError } from "../../common/errors.ts";
import { snsSuccessResponse, escapeXml } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";

export function confirmSubscription(params: Record<string, string>, snsStore: SnsStore): string {
  const topicArn = params.TopicArn;
  if (!topicArn) {
    throw new SnsError("InvalidParameter", "TopicArn is required");
  }

  // In our emulator, SQS subscriptions are auto-confirmed.
  // This is a no-op that returns the subscription ARN.
  const topic = snsStore.getTopic(topicArn);
  if (!topic) {
    throw new SnsError("NotFound", "Topic does not exist", 404);
  }

  // Find the subscription for this topic (simplified: return first)
  const subs = snsStore.listSubscriptionsByTopic(topicArn);
  const sub = subs[0];

  if (sub) {
    sub.confirmed = true;
    return snsSuccessResponse(
      "ConfirmSubscription",
      `<SubscriptionArn>${escapeXml(sub.arn)}</SubscriptionArn>`,
    );
  }

  return snsSuccessResponse(
    "ConfirmSubscription",
    `<SubscriptionArn>PendingConfirmation</SubscriptionArn>`,
  );
}
