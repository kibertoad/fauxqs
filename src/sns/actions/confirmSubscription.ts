import type { ConfirmSubscriptionResponse } from "@aws-sdk/client-sns";
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

  // Use the Token parameter (which is the subscription ARN in this emulator) to look up the specific subscription
  const token = params.Token;
  const sub = token ? snsStore.getSubscription(token) : undefined;
  // Only confirm if the subscription belongs to this topic
  const matchesTopic = sub && sub.topicArn === topicArn;

  if (matchesTopic) {
    sub.confirmed = true;
    const result = { SubscriptionArn: sub.arn } satisfies ConfirmSubscriptionResponse;
    return snsSuccessResponse(
      "ConfirmSubscription",
      `<SubscriptionArn>${escapeXml(result.SubscriptionArn!)}</SubscriptionArn>`,
    );
  }

  const result = { SubscriptionArn: "PendingConfirmation" } satisfies ConfirmSubscriptionResponse;
  return snsSuccessResponse(
    "ConfirmSubscription",
    `<SubscriptionArn>${result.SubscriptionArn}</SubscriptionArn>`,
  );
}
