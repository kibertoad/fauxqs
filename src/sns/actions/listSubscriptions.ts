import { snsSuccessResponse, escapeXml } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";

export function listSubscriptions(_params: Record<string, string>, snsStore: SnsStore): string {
  const subscriptions = snsStore.listSubscriptions();
  return formatSubscriptionList("ListSubscriptions", subscriptions);
}

export function listSubscriptionsByTopic(
  params: Record<string, string>,
  snsStore: SnsStore,
): string {
  const topicArn = params.TopicArn;
  const subscriptions = topicArn ? snsStore.listSubscriptionsByTopic(topicArn) : [];
  return formatSubscriptionList("ListSubscriptionsByTopic", subscriptions);
}

function formatSubscriptionList(
  action: string,
  subscriptions: Array<{
    arn: string;
    topicArn: string;
    protocol: string;
    endpoint: string;
  }>,
): string {
  const membersXml = subscriptions
    .map(
      (s) =>
        `<member>
        <SubscriptionArn>${escapeXml(s.arn)}</SubscriptionArn>
        <TopicArn>${escapeXml(s.topicArn)}</TopicArn>
        <Protocol>${escapeXml(s.protocol)}</Protocol>
        <Endpoint>${escapeXml(s.endpoint)}</Endpoint>
        <Owner>000000000000</Owner>
      </member>`,
    )
    .join("\n    ");

  return snsSuccessResponse(action, `<Subscriptions>${membersXml}</Subscriptions>`);
}
