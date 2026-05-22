import { randomUUID } from "node:crypto";
import { escapeXml, unescapeXml } from "../common/xml.ts";
import { DEFAULT_ACCOUNT_ID } from "../common/types.ts";
import { S3Error } from "../common/errors.ts";
import { SqsStore } from "../sqs/sqsStore.ts";
import type { SnsStore } from "../sns/snsStore.ts";
import { fanOutToSubscriptions } from "../sns/actions/publish.ts";

/** A single prefix/suffix rule constraining which object keys trigger a notification. */
export interface S3NotificationFilterRule {
  name: "prefix" | "suffix";
  value: string;
}

/** A single notification destination (an SQS queue or an SNS topic). */
export interface S3NotificationTarget {
  id?: string;
  /** Destination ARN — an SQS queue ARN or an SNS topic ARN. */
  arn: string;
  /** Event patterns, e.g. ["s3:ObjectCreated:*", "s3:ObjectRemoved:Delete"]. */
  events: string[];
  filterRules: S3NotificationFilterRule[];
}

/** A bucket's notification configuration. */
export interface S3NotificationConfiguration {
  queueConfigurations: S3NotificationTarget[];
  topicConfigurations: S3NotificationTarget[];
}

/** The minimal event description the S3 store hands to the dispatcher. */
export interface S3EventInfo {
  bucket: string;
  key: string;
  /** e.g. "ObjectCreated:Put", "ObjectRemoved:Delete". */
  eventName: string;
  size?: number;
  eTag?: string;
}

/** Delivers S3 object events to configured SQS/SNS destinations. */
export interface S3EventDispatcher {
  notify(event: S3EventInfo, config: S3NotificationConfiguration): void;
  /**
   * Validate a configuration's destination ARNs and event names, throwing an
   * `S3Error` on the first problem. Real S3 rejects unknown destinations and
   * unsupported events at `PutBucketNotificationConfiguration` time.
   */
  validateConfiguration(config: S3NotificationConfiguration): void;
}

/**
 * The complete set of event names S3 accepts in a notification configuration.
 * Validation is exact (full `Category:Leaf` name, not category-only) so a
 * misspelled leaf such as `s3:ObjectCreated:Typo` — which would silently never
 * match an emitted event — is rejected the same way real S3 rejects it.
 */
const VALID_S3_EVENT_NAMES = new Set([
  "ObjectCreated:*",
  "ObjectCreated:Put",
  "ObjectCreated:Post",
  "ObjectCreated:Copy",
  "ObjectCreated:CompleteMultipartUpload",
  "ObjectRemoved:*",
  "ObjectRemoved:Delete",
  "ObjectRemoved:DeleteMarkerCreated",
  "ObjectRestore:*",
  "ObjectRestore:Post",
  "ObjectRestore:Completed",
  "ObjectRestore:Delete",
  "ObjectTagging:*",
  "ObjectTagging:Put",
  "ObjectTagging:Delete",
  "ObjectAcl:Put",
  "ReducedRedundancyLostObject",
  "Replication:*",
  "Replication:OperationFailedReplication",
  "Replication:OperationMissedThreshold",
  "Replication:OperationReplicatedAfterThreshold",
  "Replication:OperationNotTracked",
  "LifecycleExpiration:*",
  "LifecycleExpiration:Delete",
  "LifecycleExpiration:DeleteMarkerCreated",
  "LifecycleTransition",
  "IntelligentTiering",
]);

/** Whether `event` (e.g. `"s3:ObjectCreated:*"`) names a supported S3 event. */
function isValidEventName(event: string): boolean {
  const stripped = event.startsWith("s3:") ? event.slice(3) : event;
  return VALID_S3_EVENT_NAMES.has(stripped);
}

/**
 * Encode an object key the way S3 event notifications do: spaces become `+`
 * and other reserved characters are percent-encoded, but path separators (`/`)
 * are left intact. Consumers decode it with `decodeURIComponent(key.replace(/\+/g, " "))`.
 */
function encodeEventKey(key: string): string {
  return encodeURIComponent(key).replaceAll("%2F", "/").replaceAll("%20", "+");
}

/** Extract the text content of the first `<tag>...</tag>` within `xml`. */
function textOf(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? unescapeXml(match[1].trim()) : undefined;
}

function parseTargets(xml: string, blockTag: string, arnTag: string): S3NotificationTarget[] {
  const targets: S3NotificationTarget[] = [];
  const blockRe = new RegExp(`<${blockTag}>([\\s\\S]*?)</${blockTag}>`, "g");
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(xml)) !== null) {
    const inner = block[1];
    const arn = textOf(inner, arnTag);
    if (!arn) continue;

    const id = textOf(inner, "Id");

    const events: string[] = [];
    const eventRe = /<Event>([\s\S]*?)<\/Event>/g;
    let event: RegExpExecArray | null;
    while ((event = eventRe.exec(inner)) !== null) {
      events.push(unescapeXml(event[1].trim()));
    }

    const filterRules: S3NotificationFilterRule[] = [];
    const ruleRe = /<FilterRule>([\s\S]*?)<\/FilterRule>/g;
    let rule: RegExpExecArray | null;
    while ((rule = ruleRe.exec(inner)) !== null) {
      const name = textOf(rule[1], "Name")?.toLowerCase();
      const value = textOf(rule[1], "Value");
      if ((name === "prefix" || name === "suffix") && value !== undefined) {
        filterRules.push({ name, value });
      }
    }

    targets.push({ ...(id ? { id } : {}), arn, events, filterRules });
  }
  return targets;
}

/**
 * Parse a `<NotificationConfiguration>` XML document.
 *
 * This is a deliberately small regex-based parser that handles the plain,
 * attribute-free element form the AWS SDK emits. `LambdaFunctionConfiguration`
 * and `EventBridgeConfiguration` destinations are not parsed — fauxqs only
 * dispatches S3 events to SQS queues and SNS topics.
 */
export function parseNotificationConfigXml(xml: string): S3NotificationConfiguration {
  return {
    queueConfigurations: parseTargets(xml, "QueueConfiguration", "Queue"),
    topicConfigurations: parseTargets(xml, "TopicConfiguration", "Topic"),
  };
}

function serializeTarget(target: S3NotificationTarget, blockTag: string, arnTag: string): string {
  const parts = [`  <${blockTag}>`];
  if (target.id) parts.push(`    <Id>${escapeXml(target.id)}</Id>`);
  parts.push(`    <${arnTag}>${escapeXml(target.arn)}</${arnTag}>`);
  for (const event of target.events) {
    parts.push(`    <Event>${escapeXml(event)}</Event>`);
  }
  if (target.filterRules.length > 0) {
    parts.push("    <Filter>");
    parts.push("      <S3Key>");
    for (const rule of target.filterRules) {
      parts.push(
        `        <FilterRule><Name>${rule.name}</Name><Value>${escapeXml(rule.value)}</Value></FilterRule>`,
      );
    }
    parts.push("      </S3Key>");
    parts.push("    </Filter>");
  }
  parts.push(`  </${blockTag}>`);
  return parts.join("\n");
}

/** Serialize a notification configuration to the `<NotificationConfiguration>` XML S3 returns. */
export function serializeNotificationConfigXml(config: S3NotificationConfiguration): string {
  const parts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<NotificationConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
  ];
  for (const target of config.queueConfigurations) {
    parts.push(serializeTarget(target, "QueueConfiguration", "Queue"));
  }
  for (const target of config.topicConfigurations) {
    parts.push(serializeTarget(target, "TopicConfiguration", "Topic"));
  }
  parts.push(`</NotificationConfiguration>`);
  return parts.join("\n");
}

/** Whether a target should receive `eventName` for object `key`. */
function targetMatches(target: S3NotificationTarget, eventName: string, key: string): boolean {
  const eventMatches = target.events.some((configured) => {
    const stripped = configured.startsWith("s3:") ? configured.slice(3) : configured;
    if (stripped.endsWith(":*")) {
      return eventName.startsWith(stripped.slice(0, -1));
    }
    return stripped === eventName;
  });
  if (!eventMatches) return false;

  for (const rule of target.filterRules) {
    if (rule.name === "prefix" && !key.startsWith(rule.value)) return false;
    if (rule.name === "suffix" && !key.endsWith(rule.value)) return false;
  }
  return true;
}

/**
 * Dispatches S3 object events to SQS queues and SNS topics, matching the JSON
 * envelope (`{"Records":[...]}`) that real S3 event notifications use.
 */
export class S3NotificationDispatcher implements S3EventDispatcher {
  private sequence = 0;

  constructor(
    private readonly sqsStore: SqsStore,
    private readonly snsStore: SnsStore,
    private readonly region: string,
  ) {}

  notify(event: S3EventInfo, config: S3NotificationConfiguration): void {
    if (config.queueConfigurations.length === 0 && config.topicConfigurations.length === 0) {
      return;
    }

    for (const target of config.queueConfigurations) {
      if (!targetMatches(target, event.eventName, event.key)) continue;
      const queue = this.sqsStore.getQueueByArn(target.arn);
      if (!queue) continue; // lenient: skip destinations that don't exist
      const body = JSON.stringify({ Records: [this.buildRecord(event, target.id)] });
      // FIFO destinations need a group + dedup id; group events per bucket so
      // they stay ordered, and give each event a distinct dedup id.
      const message = queue.isFifo()
        ? SqsStore.createMessage(body, {}, undefined, event.bucket, randomUUID())
        : SqsStore.createMessage(body);
      queue.enqueue(message);
    }

    for (const target of config.topicConfigurations) {
      if (!targetMatches(target, event.eventName, event.key)) continue;
      const topic = this.snsStore.getTopic(target.arn);
      if (!topic) continue;
      const body = JSON.stringify({ Records: [this.buildRecord(event, target.id)] });
      // FIFO topics require a group + dedup id; group events per bucket so they
      // stay ordered, and give each event a distinct dedup id.
      const isFifoTopic = topic.attributes.FifoTopic === "true";
      fanOutToSubscriptions({
        topicArn: target.arn,
        topic,
        messageId: randomUUID(),
        message: body,
        messageAttributes: {},
        ...(isFifoTopic
          ? { messageGroupId: event.bucket, messageDeduplicationId: randomUUID() }
          : {}),
        snsStore: this.snsStore,
        sqsStore: this.sqsStore,
      });
    }
  }

  validateConfiguration(config: S3NotificationConfiguration): void {
    const checkEvents = (target: S3NotificationTarget): void => {
      for (const event of target.events) {
        if (!isValidEventName(event)) {
          throw new S3Error(
            "InvalidArgument",
            `The event is not supported for notifications: ${event}`,
            400,
          );
        }
      }
    };
    for (const target of config.queueConfigurations) {
      checkEvents(target);
      if (!this.sqsStore.getQueueByArn(target.arn)) {
        throw new S3Error(
          "InvalidArgument",
          `Unable to validate the following destination configurations. The SQS queue does not exist: ${target.arn}`,
          400,
        );
      }
    }
    for (const target of config.topicConfigurations) {
      checkEvents(target);
      if (!this.snsStore.getTopic(target.arn)) {
        throw new S3Error(
          "InvalidArgument",
          `Unable to validate the following destination configurations. The SNS topic does not exist: ${target.arn}`,
          400,
        );
      }
    }
  }

  private buildRecord(event: S3EventInfo, configurationId?: string): Record<string, unknown> {
    const sequencer = (++this.sequence).toString(16).toUpperCase().padStart(16, "0");
    const isCreate = event.eventName.startsWith("ObjectCreated:");
    return {
      eventVersion: "2.1",
      eventSource: "aws:s3",
      awsRegion: this.region,
      eventTime: new Date().toISOString(),
      eventName: event.eventName,
      userIdentity: { principalId: DEFAULT_ACCOUNT_ID },
      requestParameters: { sourceIPAddress: "127.0.0.1" },
      responseElements: {
        "x-amz-request-id": "fauxqs",
        "x-amz-id-2": "fauxqs",
      },
      s3: {
        s3SchemaVersion: "1.0",
        configurationId: configurationId ?? "fauxqs",
        bucket: {
          name: event.bucket,
          ownerIdentity: { principalId: DEFAULT_ACCOUNT_ID },
          arn: `arn:aws:s3:::${event.bucket}`,
        },
        object: {
          // S3 event notifications deliver the key URL-encoded.
          key: encodeEventKey(event.key),
          ...(isCreate && event.size !== undefined ? { size: event.size } : {}),
          ...(isCreate && event.eTag ? { eTag: event.eTag.replaceAll('"', "") } : {}),
          sequencer,
        },
      },
    };
  }
}
