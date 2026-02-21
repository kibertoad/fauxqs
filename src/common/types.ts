export const DEFAULT_ACCOUNT_ID = "000000000000";
export const DEFAULT_REGION = "us-east-1";

// Max message size: 256 KB (262,144 bytes) for SNS
export const SNS_MAX_MESSAGE_SIZE_BYTES = 262_144;

/**
 * Extract the region from the AWS v4 Authorization header credential scope.
 * Format: AWS4-HMAC-SHA256 Credential=key/date/region/service/aws4_request, ...
 */
export function regionFromAuth(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = authHeader.match(/Credential=\S+?\/\d{8}\/([^/]+)\//);
  return match?.[1];
}
