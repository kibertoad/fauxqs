import type { Subscription } from "@aws-sdk/client-sns";
import { snsSuccessResponse, escapeXml } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";

export function listSubscriptions(params: Record<string, string>, snsStore: SnsStore): string {
  const nextToken = params.NextToken;
  const result = snsStore.listSubscriptions(nextToken || undefined);
  return formatSubscriptionList("ListSubscriptions", result.subscriptions, result.nextToken);
}

export function listSubscriptionsByTopic(
  params: Record<string, string>,
  snsStore: SnsStore,
): string {
  const topicArn = params.TopicArn;
  const nextToken = params.NextToken;
  if (!topicArn) {
    return formatSubscriptionList("ListSubscriptionsByTopic", []);
  }
  const result = snsStore.listSubscriptionsByTopic(topicArn, nextToken || undefined);
  return formatSubscriptionList("ListSubscriptionsByTopic", result.subscriptions, result.nextToken);
}

function formatSubscriptionList(
  action: string,
  subscriptions: Array<{
    arn: string;
    topicArn: string;
    protocol: string;
    endpoint: string;
  }>,
  nextToken?: string,
): string {
  const membersXml = subscriptions
    .map((s) => {
      const sub = {
        SubscriptionArn: s.arn,
        TopicArn: s.topicArn,
        Protocol: s.protocol,
        Endpoint: s.endpoint,
        Owner: "000000000000",
      } satisfies Subscription;
      return `<member>
        <SubscriptionArn>${escapeXml(sub.SubscriptionArn!)}</SubscriptionArn>
        <TopicArn>${escapeXml(sub.TopicArn!)}</TopicArn>
        <Protocol>${escapeXml(sub.Protocol!)}</Protocol>
        <Endpoint>${escapeXml(sub.Endpoint!)}</Endpoint>
        <Owner>${sub.Owner}</Owner>
      </member>`;
    })
    .join("\n    ");

  const nextTokenXml = nextToken
    ? `<NextToken>${escapeXml(nextToken)}</NextToken>`
    : "";

  return snsSuccessResponse(action, `<Subscriptions>${membersXml}</Subscriptions>${nextTokenXml}`);
}
