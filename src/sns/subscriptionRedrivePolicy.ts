import { SnsError } from "../common/errors.ts";

/** Parsed shape of a subscription RedrivePolicy; we only care about the DLQ ARN. */
export interface ParsedSubscriptionRedrivePolicy {
  deadLetterTargetArn?: string;
}

/**
 * Validate a RedrivePolicy attribute value at write time (Subscribe /
 * SetSubscriptionAttributes). Mirrors how AWS rejects malformed input
 * synchronously rather than silently dropping messages at publish time.
 *
 * An empty string is allowed: SetSubscriptionAttributes uses it to clear the
 * policy. Any non-empty value must parse to a JSON object; if
 * `deadLetterTargetArn` is present it must be a string.
 */
export function validateSubscriptionRedrivePolicy(raw: string): void {
  if (raw === "") return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SnsError(
      "InvalidParameter",
      "Invalid parameter: RedrivePolicy: Amazon SNS was unable to parse RedrivePolicy as JSON.",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SnsError(
      "InvalidParameter",
      "Invalid parameter: RedrivePolicy: must be a JSON object.",
    );
  }

  const dlqArn = (parsed as { deadLetterTargetArn?: unknown }).deadLetterTargetArn;
  if (dlqArn !== undefined && typeof dlqArn !== "string") {
    throw new SnsError(
      "InvalidParameter",
      "Invalid parameter: RedrivePolicy: deadLetterTargetArn must be a string ARN.",
    );
  }
}

/**
 * Parse a stored RedrivePolicy value defensively. Returns `null` when the
 * value is absent, malformed, or doesn't conform to the expected shape —
 * write-time validation should already have rejected malformed input, but
 * subscriptions loaded from older persistence snapshots may not have been
 * validated, so we narrow here too.
 */
export function parseSubscriptionRedrivePolicy(
  raw: string | undefined,
): ParsedSubscriptionRedrivePolicy | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const dlqArn = (parsed as { deadLetterTargetArn?: unknown }).deadLetterTargetArn;
  if (dlqArn !== undefined && typeof dlqArn !== "string") {
    return null;
  }

  return { deadLetterTargetArn: dlqArn };
}
