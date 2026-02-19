import { SnsError } from "../../common/errors.ts";
import { snsSuccessResponse, escapeXml } from "../../common/xml.ts";
import type { SnsStore } from "../snsStore.ts";

export function tagResource(params: Record<string, string>, snsStore: SnsStore): string {
  const resourceArn = params.ResourceArn;
  if (!resourceArn) {
    throw new SnsError("InvalidParameter", "ResourceArn is required");
  }

  const topic = snsStore.getTopic(resourceArn);
  if (!topic) {
    throw new SnsError("NotFound", "Resource does not exist", 404);
  }

  // Parse Tags.member.N.Key/Value
  for (const [key, value] of Object.entries(params)) {
    const match = key.match(/^Tags\.member\.(\d+)\.Key$/);
    if (match) {
      const idx = match[1];
      const tagValue = params[`Tags.member.${idx}.Value`] ?? "";
      topic.tags.set(value, tagValue);
    }
  }

  return snsSuccessResponse("TagResource", "");
}

export function untagResource(params: Record<string, string>, snsStore: SnsStore): string {
  const resourceArn = params.ResourceArn;
  if (!resourceArn) {
    throw new SnsError("InvalidParameter", "ResourceArn is required");
  }

  const topic = snsStore.getTopic(resourceArn);
  if (!topic) {
    throw new SnsError("NotFound", "Resource does not exist", 404);
  }

  // Parse TagKeys.member.N
  for (const [key, value] of Object.entries(params)) {
    const match = key.match(/^TagKeys\.member\.(\d+)$/);
    if (match) {
      topic.tags.delete(value);
    }
  }

  return snsSuccessResponse("UntagResource", "");
}

export function listTagsForResource(params: Record<string, string>, snsStore: SnsStore): string {
  const resourceArn = params.ResourceArn;
  if (!resourceArn) {
    throw new SnsError("InvalidParameter", "ResourceArn is required");
  }

  const topic = snsStore.getTopic(resourceArn);
  if (!topic) {
    throw new SnsError("NotFound", "Resource does not exist", 404);
  }

  const membersXml = Array.from(topic.tags.entries())
    .map(
      ([key, value]) =>
        `<member><Key>${escapeXml(key)}</Key><Value>${escapeXml(value)}</Value></member>`,
    )
    .join("\n    ");

  return snsSuccessResponse("ListTagsForResource", `<Tags>${membersXml}</Tags>`);
}
