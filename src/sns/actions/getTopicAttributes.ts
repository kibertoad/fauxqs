import { DEFAULT_ACCOUNT_ID } from "../../common/types.ts";
import { SnsError } from "../../common/errors.ts";
import { snsSuccessResponse, escapeXml } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";

const DEFAULT_EFFECTIVE_DELIVERY_POLICY = JSON.stringify({
  http: {
    defaultHealthyRetryPolicy: {
      minDelayTarget: 20,
      maxDelayTarget: 20,
      numRetries: 3,
      numMaxDelayRetries: 0,
      numNoDelayRetries: 0,
      numMinDelayRetries: 0,
      backoffFunction: "linear",
    },
    disableSubscriptionOverrides: false,
  },
});

export function getTopicAttributes(params: Record<string, string>, snsStore: SnsStore): string {
  const topicArn = params.TopicArn;
  if (!topicArn) {
    throw new SnsError("InvalidParameter", "TopicArn is required");
  }

  const topic = snsStore.getTopic(topicArn);
  if (!topic) {
    throw new SnsError("NotFound", "Topic does not exist", 404);
  }

  let confirmed = 0;
  let pending = 0;
  for (const subArn of topic.subscriptionArns) {
    const sub = snsStore.getSubscription(subArn);
    if (sub?.confirmed) {
      confirmed++;
    } else {
      pending++;
    }
  }

  const allAttributes: Record<string, string> = {
    TopicArn: topic.arn,
    Owner: DEFAULT_ACCOUNT_ID,
    DisplayName: "",
    EffectiveDeliveryPolicy: DEFAULT_EFFECTIVE_DELIVERY_POLICY,
    SubscriptionsConfirmed: String(confirmed),
    SubscriptionsPending: String(pending),
    SubscriptionsDeleted: "0",
    ...topic.attributes,
  };

  const entriesXml = Object.entries(allAttributes)
    .map(
      ([key, value]) =>
        `<entry><key>${escapeXml(key)}</key><value>${escapeXml(value)}</value></entry>`,
    )
    .join("\n    ");

  return snsSuccessResponse("GetTopicAttributes", `<Attributes>${entriesXml}</Attributes>`);
}
