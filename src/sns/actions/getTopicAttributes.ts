import { SnsError } from "../../common/errors.js";
import { snsSuccessResponse, escapeXml } from "../../common/xml.js";
import type { SnsStore } from "../snsStore.js";

export function getTopicAttributes(
  params: Record<string, string>,
  snsStore: SnsStore,
): string {
  const topicArn = params.TopicArn;
  if (!topicArn) {
    throw new SnsError("InvalidParameter", "TopicArn is required");
  }

  const topic = snsStore.getTopic(topicArn);
  if (!topic) {
    throw new SnsError("NotFound", "Topic does not exist", 404);
  }

  const allAttributes: Record<string, string> = {
    TopicArn: topic.arn,
    DisplayName: topic.attributes.DisplayName ?? topic.name,
    SubscriptionsConfirmed: String(
      topic.subscriptionArns.length,
    ),
    SubscriptionsPending: "0",
    SubscriptionsDeleted: "0",
    ...topic.attributes,
  };

  const entriesXml = Object.entries(allAttributes)
    .map(
      ([key, value]) =>
        `<entry><key>${escapeXml(key)}</key><value>${escapeXml(value)}</value></entry>`,
    )
    .join("\n    ");

  return snsSuccessResponse(
    "GetTopicAttributes",
    `<Attributes>${entriesXml}</Attributes>`,
  );
}
