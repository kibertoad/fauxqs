import { snsSuccessResponse, escapeXml } from "../../common/xml.js";
import type { SnsStore } from "../snsStore.js";

export function listTopics(
  _params: Record<string, string>,
  snsStore: SnsStore,
): string {
  const topics = snsStore.listTopics();

  const membersXml = topics
    .map((t) => `<member><TopicArn>${escapeXml(t.arn)}</TopicArn></member>`)
    .join("\n    ");

  return snsSuccessResponse(
    "ListTopics",
    `<Topics>${membersXml}</Topics>`,
  );
}
