import type { ListTopicsResponse, Topic } from "@aws-sdk/client-sns";
import { snsSuccessResponse, escapeXml } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";

export function listTopics(_params: Record<string, string>, snsStore: SnsStore): string {
  const topics = snsStore.listTopics();

  const result = {
    Topics: topics.map((t) => ({ TopicArn: t.arn }) satisfies Topic),
  } satisfies ListTopicsResponse;

  const membersXml = result
    .Topics!.map((t) => `<member><TopicArn>${escapeXml(t.TopicArn!)}</TopicArn></member>`)
    .join("\n    ");

  return snsSuccessResponse("ListTopics", `<Topics>${membersXml}</Topics>`);
}
