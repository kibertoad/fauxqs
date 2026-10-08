import { randomUUID } from "node:crypto";
import { snsTopicArn, snsSubscriptionArn, parseArn } from "../common/arnHelper.ts";
import { SnsError } from "../common/errors.ts";
import type { MessageSpy } from "../spy.ts";
import type { PersistenceManager } from "../persistence.ts";
import type { SnsTopic, SnsSubscription } from "./snsTypes.ts";
import { validateFilterPolicyLimits } from "./filter.ts";
import { validateSubscriptionRedrivePolicy } from "./subscriptionRedrivePolicy.ts";

// NOTE: When adding new public methods that look up a topic by ARN,
// also override them in src/tenant/trackedStores.ts → TrackedSnsStore so that
// tenant usage tracking stays accurate.
export class SnsStore {
  topics = new Map<string, SnsTopic>();
  subscriptions = new Map<string, SnsSubscription>();
  region?: string;
  spy?: MessageSpy;
  persistence?: PersistenceManager;

  createTopic(
    name: string,
    attributes: Record<string, string> | undefined,
    tags: Record<string, string> | undefined,
    region: string,
  ): SnsTopic {
    const arn = snsTopicArn(name, region);

    const existing = this.topics.get(arn);
    if (existing) {
      // One-directional attribute check: only reject when a provided attribute value conflicts
      // with an existing value. Missing attributes on the existing topic are not conflicts —
      // they are merged in. This matches real AWS behaviour where CreateTopic is idempotent
      // and allows different callers (e.g. consumer vs publisher in @message-queue-toolkit)
      // to assertTopic with different attribute subsets without conflict.
      if (attributes) {
        for (const [key, value] of Object.entries(attributes)) {
          if (key in existing.attributes && existing.attributes[key] !== value) {
            throw new SnsError(
              "InvalidParameter",
              "Invalid parameter: Attributes Reason: Topic already exists with different attributes",
            );
          }
        }
        Object.assign(existing.attributes, attributes);
      }
      // Full tag set comparison: AWS rejects CreateTopic when the provided tags
      // don't exactly match the existing topic's tags (same keys, same values, same count).
      if (tags) {
        if (!attributesEqual(tags, Object.fromEntries(existing.tags))) {
          throw new SnsError(
            "InvalidParameter",
            "Invalid parameter: Tags Reason: Topic already exists with different tags",
          );
        }
      }
      return existing;
    }

    const topic: SnsTopic = {
      arn,
      name,
      attributes: attributes ?? {},
      tags: new Map(tags ? Object.entries(tags) : []),
      subscriptionArns: [],
    };
    this.topics.set(arn, topic);
    this.persistence?.insertTopic(topic);
    return topic;
  }

  deleteTopic(arn: string): boolean {
    const topic = this.topics.get(arn);
    if (!topic) return false;

    // Remove associated subscriptions
    for (const subArn of topic.subscriptionArns) {
      this.subscriptions.delete(subArn);
      this.persistence?.deleteSubscription(subArn);
    }

    this.topics.delete(arn);
    this.persistence?.deleteTopic(arn);
    return true;
  }

  getTopic(arn: string): SnsTopic | undefined {
    return this.topics.get(arn);
  }

  allTopics(): Iterable<SnsTopic> {
    return this.topics.values();
  }

  listTopics(nextToken?: string): { topics: SnsTopic[]; nextToken?: string } {
    let topics = Array.from(this.topics.values()).sort((a, b) => a.arn.localeCompare(b.arn));
    if (nextToken) {
      topics = topics.filter((t) => t.arn > nextToken);
    }
    if (topics.length > 100) {
      const resultToken = topics[99].arn;
      return { topics: topics.slice(0, 100), nextToken: resultToken };
    }
    return { topics };
  }

  subscribe(
    topicArn: string,
    protocol: string,
    endpoint: string,
    attributes?: Record<string, string>,
  ): SnsSubscription | undefined {
    const topic = this.topics.get(topicArn);
    if (!topic) return undefined;

    attributes = normalizeSubscribeAttributes(attributes);

    const existing = this.findSubscription(topicArn, protocol, endpoint);
    if (existing) {
      if (!attributesEqual(attributes ?? {}, existing.attributes)) {
        throw new SnsError(
          "InvalidParameter",
          "Invalid parameter: Attributes Reason: Subscription already exists with different attributes",
        );
      }
      return existing;
    }

    const id = randomUUID();
    const topicRegion = parseArn(topicArn).region;
    const arn = snsSubscriptionArn(topic.name, id, topicRegion);

    const subscription: SnsSubscription = {
      arn,
      topicArn,
      protocol,
      endpoint,
      confirmed: protocol === "sqs",
      attributes: attributes ?? {},
    };

    this.subscriptions.set(arn, subscription);
    topic.subscriptionArns.push(arn);
    this.persistence?.insertSubscription(subscription);
    this.persistence?.updateTopicSubscriptionArns(topicArn, topic.subscriptionArns);
    return subscription;
  }

  findSubscription(
    topicArn: string,
    protocol: string,
    endpoint: string,
  ): SnsSubscription | undefined {
    const topic = this.topics.get(topicArn);
    if (!topic) return undefined;
    for (const subArn of topic.subscriptionArns) {
      const sub = this.subscriptions.get(subArn);
      if (sub && sub.protocol === protocol && sub.endpoint === endpoint) return sub;
    }
    return undefined;
  }

  /**
   * Applies the attributes a declarative caller such as init config states for an
   * existing subscription. Subscribe rejects a changed value, as AWS does. Attributes
   * missing from `attributes` are kept, so values set at runtime survive a restart.
   * Returns whether anything changed.
   */
  mergeSubscriptionAttributes(
    subscription: SnsSubscription,
    attributes: Record<string, string> | undefined,
  ): boolean {
    const desired = normalizeSubscribeAttributes(attributes) ?? {};
    let changed = false;
    for (const [name, value] of Object.entries(desired)) {
      if (subscription.attributes[name] !== value) {
        setSubscriptionAttribute(subscription, name, value);
        changed = true;
      }
    }
    if (changed) {
      this.persistence?.updateSubscriptionAttributes(subscription.arn, subscription.attributes);
    }
    return changed;
  }

  /**
   * Applies the attributes and tags a declarative caller states for an existing topic.
   * CreateTopic rejects a changed attribute value or tag set, as AWS does. Attributes
   * missing from `attributes` are kept, matching CreateTopic's merge. Returns whether
   * anything changed.
   */
  reconcileTopic(
    topic: SnsTopic,
    attributes: Record<string, string> | undefined,
    tags: Record<string, string> | undefined,
  ): boolean {
    let attributesChanged = false;
    if (attributes) {
      const merged = { ...topic.attributes, ...attributes };
      if (!attributesEqual(merged, topic.attributes)) {
        topic.attributes = merged;
        attributesChanged = true;
      }
    }

    const tagsChanged = !!tags && !attributesEqual(tags, Object.fromEntries(topic.tags));
    if (tagsChanged) {
      topic.tags = new Map(Object.entries(tags));
      // insertTopic rewrites the whole row, attributes included.
      this.persistence?.insertTopic(topic);
    } else if (attributesChanged) {
      this.persistence?.updateTopicAttributes(topic.arn, topic.attributes);
    }

    return attributesChanged || tagsChanged;
  }

  unsubscribe(arn: string): boolean {
    const sub = this.subscriptions.get(arn);
    if (!sub) return false;

    const topic = this.topics.get(sub.topicArn);
    if (topic) {
      topic.subscriptionArns = topic.subscriptionArns.filter((s) => s !== arn);
      this.persistence?.updateTopicSubscriptionArns(sub.topicArn, topic.subscriptionArns);
    }

    this.subscriptions.delete(arn);
    this.persistence?.deleteSubscription(arn);
    return true;
  }

  getSubscription(arn: string): SnsSubscription | undefined {
    return this.subscriptions.get(arn);
  }

  listSubscriptions(nextToken?: string): { subscriptions: SnsSubscription[]; nextToken?: string } {
    let subs = Array.from(this.subscriptions.values()).sort((a, b) => a.arn.localeCompare(b.arn));
    if (nextToken) {
      subs = subs.filter((s) => s.arn > nextToken);
    }
    if (subs.length > 100) {
      const resultToken = subs[99].arn;
      return { subscriptions: subs.slice(0, 100), nextToken: resultToken };
    }
    return { subscriptions: subs };
  }

  listSubscriptionsByTopic(
    topicArn: string,
    nextToken?: string,
  ): { subscriptions: SnsSubscription[]; nextToken?: string } {
    const topic = this.topics.get(topicArn);
    if (!topic) return { subscriptions: [] };
    let subs = topic.subscriptionArns
      .map((arn) => this.subscriptions.get(arn))
      .filter((s): s is SnsSubscription => s !== undefined)
      .sort((a, b) => a.arn.localeCompare(b.arn));
    if (nextToken) {
      subs = subs.filter((s) => s.arn > nextToken);
    }
    if (subs.length > 100) {
      const resultToken = subs[99].arn;
      return { subscriptions: subs.slice(0, 100), nextToken: resultToken };
    }
    return { subscriptions: subs };
  }

  purgeAll(): void {
    this.topics.clear();
    this.subscriptions.clear();
  }
}

/**
 * Write a subscription attribute and invalidate any cached parsed form. The
 * only sanctioned way to mutate `subscription.attributes` for keys that have
 * derived caches (FilterPolicy, FilterPolicyScope, RedrivePolicy) — callers
 * that reach into `attributes` directly will leave stale cache entries.
 */
export function setSubscriptionAttribute(
  subscription: SnsSubscription,
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete subscription.attributes[name];
  } else {
    subscription.attributes[name] = value;
  }
  if (name === "FilterPolicy" || name === "FilterPolicyScope") {
    subscription.parsedFilterPolicy = undefined;
  }
  if (name === "RedrivePolicy") {
    subscription.parsedRedrivePolicy = undefined;
  }
}

export function attributesEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  return aKeys.length === Object.keys(b).length && aKeys.every((key) => b[key] === a[key]);
}

/**
 * Validates Subscribe attributes and drops an empty FilterPolicy, which
 * SetSubscriptionAttributes also treats as no policy. Lives in the store so the
 * API, programmatic and init-config subscribe paths all apply it.
 */
function normalizeSubscribeAttributes(
  attributes: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!attributes) return undefined;

  const normalized = { ...attributes };
  if (normalized.FilterPolicy === "") delete normalized.FilterPolicy;
  if (normalized.FilterPolicy !== undefined) validateFilterPolicyLimits(normalized.FilterPolicy);
  if (normalized.RedrivePolicy !== undefined) {
    validateSubscriptionRedrivePolicy(normalized.RedrivePolicy);
  }
  return normalized;
}

/**
 * Removes empty FilterPolicy and RedrivePolicy values, which older versions
 * stored when a policy was cleared. Returns whether anything was removed.
 */
export function dropEmptySubscriptionPolicies(attributes: Record<string, string>): boolean {
  let changed = false;
  for (const name of ["FilterPolicy", "RedrivePolicy"]) {
    if (attributes[name] === "") {
      delete attributes[name];
      changed = true;
    }
  }
  return changed;
}
