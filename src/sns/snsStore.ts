import { randomUUID } from "node:crypto";
import { snsTopicArn, snsSubscriptionArn, parseArn } from "../common/arnHelper.ts";
import { SnsError } from "../common/errors.ts";
import type { MessageSpy } from "../spy.ts";
import type { PersistenceProvider } from "../persistence/index.ts";
import type { SnsTopic, SnsSubscription } from "./snsTypes.ts";

// NOTE: When adding new public methods that look up a topic by ARN,
// also override them in src/tenant/trackedStores.ts → TrackedSnsStore so that
// tenant usage tracking stays accurate.
export class SnsStore {
  topics = new Map<string, SnsTopic>();
  subscriptions = new Map<string, SnsSubscription>();
  region?: string;
  spy?: MessageSpy;
  persistence?: PersistenceProvider;
  private subscriptionListTails = new Map<string, Promise<unknown>>();

  async createTopic(
    name: string,
    attributes: Record<string, string> | undefined,
    tags: Record<string, string> | undefined,
    region: string,
  ): Promise<SnsTopic> {
    const arn = snsTopicArn(name, region);

    const existing = this.topics.get(arn);
    if (existing) {
      // One-directional attribute check: only reject when a provided attribute value conflicts
      // with an existing value. Missing attributes on the existing topic are not conflicts —
      // they are merged in. This matches real AWS behaviour where CreateTopic is idempotent
      // and allows different callers (e.g. consumer vs publisher in @message-queue-toolkit)
      // to assertTopic with different attribute subsets without conflict.
      if (attributes) {
        let adds = false;
        for (const [key, value] of Object.entries(attributes)) {
          if (key in existing.attributes && existing.attributes[key] !== value) {
            throw new SnsError(
              "InvalidParameter",
              "Invalid parameter: Attributes Reason: Topic already exists with different attributes",
            );
          }
          if (!(key in existing.attributes)) adds = true;
        }
        if (adds) {
          const merged = { ...existing.attributes, ...attributes };
          await this.persistence?.updateTopicAttributes(arn, merged);
          existing.attributes = merged;
        }
      }
      // Full tag set comparison: AWS rejects CreateTopic when the provided tags
      // don't exactly match the existing topic's tags (same keys, same values, same count).
      if (tags) {
        const newTags = new Map(Object.entries(tags));
        const tagsMatch =
          newTags.size === existing.tags.size &&
          [...newTags].every(
            ([key, value]) => existing.tags.has(key) && existing.tags.get(key) === value,
          );
        if (!tagsMatch) {
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
    // Persisted before it becomes visible, so a failed write leaves no topic
    // that exists only in memory.
    await this.persistence?.insertTopic(topic);
    this.topics.set(arn, topic);
    return topic;
  }

  async deleteTopic(arn: string): Promise<boolean> {
    const topic = this.topics.get(arn);
    if (!topic) return false;

    // Persist the removals first; memory changes only once they have succeeded.
    const subscriptionArns = [...topic.subscriptionArns];
    for (const subArn of subscriptionArns) {
      await this.persistence?.deleteSubscription(subArn);
    }
    await this.persistence?.deleteTopic(arn);

    for (const subArn of subscriptionArns) {
      this.subscriptions.delete(subArn);
    }
    this.topics.delete(arn);
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

  async subscribe(
    topicArn: string,
    protocol: string,
    endpoint: string,
    attributes?: Record<string, string>,
  ): Promise<SnsSubscription | undefined> {
    const topic = this.topics.get(topicArn);
    if (!topic) return undefined;

    return this.withSubscriptionList(topicArn, () =>
      this.subscribeLocked(topic, protocol, endpoint, attributes),
    );
  }

  /**
   * Runs changes to one topic's subscription list one at a time. Each change
   * persists the whole list, so two overlapping ones would otherwise each write
   * a list missing the other's arn.
   */
  private withSubscriptionList<T>(topicArn: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.subscriptionListTails.get(topicArn) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    this.subscriptionListTails.set(topicArn, tail);
    void tail.then(() => {
      if (this.subscriptionListTails.get(topicArn) === tail) {
        this.subscriptionListTails.delete(topicArn);
      }
    });
    return run;
  }

  private async subscribeLocked(
    topic: SnsTopic,
    protocol: string,
    endpoint: string,
    attributes?: Record<string, string>,
  ): Promise<SnsSubscription> {
    const topicArn = topic.arn;
    // Check for existing subscription with same (topicArn, protocol, endpoint)
    for (const subArn of topic.subscriptionArns) {
      const existing = this.subscriptions.get(subArn);
      if (existing && existing.protocol === protocol && existing.endpoint === endpoint) {
        // Check if attributes differ
        const newAttrs = attributes ?? {};
        const existingAttrs = existing.attributes;
        const allKeys = new Set([...Object.keys(newAttrs), ...Object.keys(existingAttrs)]);
        let differs = false;
        for (const key of allKeys) {
          if (newAttrs[key] !== existingAttrs[key]) {
            differs = true;
            break;
          }
        }
        if (differs) {
          throw new SnsError(
            "InvalidParameter",
            "Invalid parameter: Attributes Reason: Subscription already exists with different attributes",
          );
        }
        return existing;
      }
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

    // Both writes land before the subscription becomes visible, so a publish
    // never delivers to a subscription that is then rolled back.
    await this.persistence?.insertSubscription(subscription);
    try {
      await this.persistence?.updateTopicSubscriptionArns(topicArn, [
        ...topic.subscriptionArns,
        arn,
      ]);
    } catch (err) {
      try {
        await this.persistence?.deleteSubscription(arn);
      } catch {
        // Best effort: the error being rethrown below is the one to report.
      }
      throw err;
    }
    this.subscriptions.set(arn, subscription);
    topic.subscriptionArns.push(arn);
    return subscription;
  }

  async unsubscribe(arn: string): Promise<boolean> {
    const sub = this.subscriptions.get(arn);
    if (!sub) return false;

    return this.withSubscriptionList(sub.topicArn, async () => {
      // Already removed by a call that held the list before this one.
      if (!this.subscriptions.has(arn)) return false;
      const topic = this.topics.get(sub.topicArn);
      if (topic) {
        const remaining = topic.subscriptionArns.filter((s) => s !== arn);
        await this.persistence?.updateTopicSubscriptionArns(sub.topicArn, remaining);
        topic.subscriptionArns = remaining;
      }

      await this.persistence?.deleteSubscription(arn);
      this.subscriptions.delete(arn);
      return true;
    });
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
  value: string,
): void {
  subscription.attributes[name] = value;
  if (name === "FilterPolicy" || name === "FilterPolicyScope") {
    subscription.parsedFilterPolicy = undefined;
  }
  if (name === "RedrivePolicy") {
    subscription.parsedRedrivePolicy = undefined;
  }
}
