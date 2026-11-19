import { xmlBlocks, xmlElement } from "../common/xml.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The parts of a lifecycle rule that fauxqs enforces. */
export interface LifecycleRule {
  prefix: string;
  objectSizeGreaterThan?: number;
  objectSizeLessThan?: number;
  /** Objects expire this many days after `lastModified`, rounded up to midnight UTC. */
  expirationDays?: number;
  /** Objects expire once the clock reaches this time. */
  expirationDate?: number;
  /** Incomplete multipart uploads are aborted this many days after initiation. */
  abortIncompleteMultipartUploadDays?: number;
}

function positiveInteger(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text.trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Read the enabled rules of a lifecycle configuration document that expire objects or abort
 * incomplete multipart uploads. Transitions and noncurrent-version actions have no effect in
 * fauxqs and are skipped. A rule with a `<Tag>` filter is skipped too: fauxqs stores no object
 * tags, so such a rule matches nothing.
 */
export function parseLifecycleRules(xml: string): LifecycleRule[] {
  const rules: LifecycleRule[] = [];
  for (const block of xmlBlocks(xml, "Rule")) {
    if (xmlElement(block, "Status")?.trim() !== "Enabled") continue;
    if (block.includes("<Tag>")) continue;

    const expiration = xmlBlocks(block, "Expiration")[0];
    const abort = xmlBlocks(block, "AbortIncompleteMultipartUpload")[0];
    const expirationDays = positiveInteger(expiration && xmlElement(expiration, "Days"));
    const dateText = expiration && xmlElement(expiration, "Date");
    const parsedDate = dateText === undefined ? Number.NaN : Date.parse(dateText.trim());
    const expirationDate = Number.isNaN(parsedDate) ? undefined : parsedDate;
    const abortDays = positiveInteger(abort && xmlElement(abort, "DaysAfterInitiation"));
    if (expirationDays === undefined && expirationDate === undefined && abortDays === undefined) {
      continue;
    }

    // <Prefix> sits directly in the rule (the older form), in <Filter>, or in <Filter><And>.
    // An absent or empty prefix matches every key.
    const objectSizeGreaterThan = nonNegativeInteger(xmlElement(block, "ObjectSizeGreaterThan"));
    const objectSizeLessThan = nonNegativeInteger(xmlElement(block, "ObjectSizeLessThan"));
    rules.push({
      prefix: xmlElement(block, "Prefix") ?? "",
      ...(objectSizeGreaterThan !== undefined && { objectSizeGreaterThan }),
      ...(objectSizeLessThan !== undefined && { objectSizeLessThan }),
      ...(expirationDays !== undefined && { expirationDays }),
      ...(expirationDate !== undefined && { expirationDate }),
      ...(abortDays !== undefined && { abortIncompleteMultipartUploadDays: abortDays }),
    });
  }
  return rules;
}

/** S3 adds the rule's days to the start time and rounds the result up to the next midnight UTC. */
function dueAfterDays(start: number, days: number): number {
  return Math.ceil((start + days * DAY_MS) / DAY_MS) * DAY_MS;
}

export function objectExpiredByRules(
  rules: LifecycleRule[],
  key: string,
  size: number,
  lastModified: number,
  now: number,
): boolean {
  for (const rule of rules) {
    if (!key.startsWith(rule.prefix)) continue;
    if (rule.objectSizeGreaterThan !== undefined && size <= rule.objectSizeGreaterThan) continue;
    if (rule.objectSizeLessThan !== undefined && size >= rule.objectSizeLessThan) continue;
    if (rule.expirationDate !== undefined && now >= rule.expirationDate) return true;
    if (
      rule.expirationDays !== undefined &&
      now >= dueAfterDays(lastModified, rule.expirationDays)
    ) {
      return true;
    }
  }
  return false;
}

export function uploadAbortedByRules(
  rules: LifecycleRule[],
  key: string,
  initiated: number,
  now: number,
): boolean {
  for (const rule of rules) {
    if (rule.abortIncompleteMultipartUploadDays === undefined) continue;
    // S3 rejects this action on a rule filtered by object size, since an upload has no size yet.
    if (rule.objectSizeGreaterThan !== undefined || rule.objectSizeLessThan !== undefined) continue;
    if (!key.startsWith(rule.prefix)) continue;
    if (now >= dueAfterDays(initiated, rule.abortIncompleteMultipartUploadDays)) return true;
  }
  return false;
}
