import { randomUUID } from "node:crypto";
import { DEFAULT_ACCOUNT_ID } from "../common/types.ts";

const STS_XMLNS = "https://sts.amazonaws.com/doc/2011-06-15/";

export function getCallerIdentity(): string {
  const arn = `arn:aws:iam::${DEFAULT_ACCOUNT_ID}:root`;
  return [
    `<GetCallerIdentityResponse xmlns="${STS_XMLNS}">`,
    `  <GetCallerIdentityResult>`,
    `    <Arn>${arn}</Arn>`,
    `    <UserId>${DEFAULT_ACCOUNT_ID}</UserId>`,
    `    <Account>${DEFAULT_ACCOUNT_ID}</Account>`,
    `  </GetCallerIdentityResult>`,
    `  <ResponseMetadata>`,
    `    <RequestId>${randomUUID()}</RequestId>`,
    `  </ResponseMetadata>`,
    `</GetCallerIdentityResponse>`,
  ].join("\n");
}
