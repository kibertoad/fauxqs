import type { SubscribeResponse } from "@aws-sdk/client-sns";
import { SnsError } from "../../common/errors.ts";
import { snsSuccessResponse, escapeXml } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";

export function subscribe(params: Record<string, string>, snsStore: SnsStore): string {
  const topicArn = params.TopicArn;
  if (!topicArn) {
    throw new SnsError("InvalidParameter", "TopicArn is required");
  }

  const protocol = params.Protocol;
  if (!protocol) {
    throw new SnsError("InvalidParameter", "Protocol is required");
  }

  const endpoint = params.Endpoint;
  if (!endpoint) {
    throw new SnsError("InvalidParameter", "Endpoint is required");
  }

  // Parse subscription attributes
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const match = key.match(/^Attributes\.entry\.(\d+)\.(key|value)$/);
    if (match) {
      const idx = match[1];
      const field = match[2];
      if (field === "key") {
        attributes[`__key_${idx}`] = value;
      } else {
        attributes[`__val_${idx}`] = value;
      }
    }
  }

  const resolvedAttributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith("__key_")) {
      const idx = key.slice(6);
      const val = attributes[`__val_${idx}`];
      if (val !== undefined) {
        resolvedAttributes[value] = val;
      }
    }
  }

  const subscription = snsStore.subscribe(
    topicArn,
    protocol,
    endpoint,
    Object.keys(resolvedAttributes).length > 0 ? resolvedAttributes : undefined,
  );

  if (!subscription) {
    throw new SnsError("NotFound", "Topic does not exist", 404);
  }

  const result = { SubscriptionArn: subscription.arn } satisfies SubscribeResponse;
  return snsSuccessResponse(
    "Subscribe",
    `<SubscriptionArn>${escapeXml(result.SubscriptionArn!)}</SubscriptionArn>`,
  );
}
