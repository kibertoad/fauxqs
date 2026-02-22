import type { ListTopicsResponse, Topic } from "@aws-sdk/client-sns";
import { snsSuccessResponse, escapeXml } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";

export function listTopics(params: Record<string, string>, snsStore: SnsStore): string {
  const nextToken = params.NextToken;
  const result = snsStore.listTopics(nextToken || undefined);

  const membersXml = result.topics
    .map((t) => `<member><TopicArn>${escapeXml(t.arn)}</TopicArn></member>`)
    .join("\n    ");

  const nextTokenXml = result.nextToken
    ? `<NextToken>${escapeXml(result.nextToken)}</NextToken>`
    : "";

  return snsSuccessResponse("ListTopics", `<Topics>${membersXml}</Topics>${nextTokenXml}`);
}
