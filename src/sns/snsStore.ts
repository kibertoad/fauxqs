import { randomUUID } from "node:crypto";
import { snsTopicArn, snsSubscriptionArn, parseArn } from "../common/arnHelper.ts";
import { SnsError } from "../common/errors.ts";
import type { MessageSpy } from "../spy.ts";
import type { SnsTopic, SnsSubscription } from "./snsTypes.ts";

export class SnsStore {
  topics = new Map<string, SnsTopic>();
  subscriptions = new Map<string, SnsSubscription>();
  region?: string;
  spy?: MessageSpy;

  createTopic(
    name: string,
    attributes: Record<string, string> | undefined,
    tags: Record<string, string> | undefined,
    region: string,
  ): SnsTopic {
    const arn = snsTopicArn(name, region);

    const existing = this.topics.get(arn);
    if (existing) {
      // One-directional attribute check: only validate attributes provided in the request.
      // AWS does not reject a CreateTopic call that omits attributes present on the existing topic —
      // it only rejects when a provided attribute value conflicts with the existing value.
      // This matches real AWS behaviour and allows different callers (e.g. consumer vs publisher in
      // @message-queue-toolkit) to assertTopic with different attribute subsets without conflict.
      if (attributes) {
        for (const [key, value] of Object.entries(attributes)) {
          if (existing.attributes[key] !== value) {
            throw new SnsError(
              "InvalidParameter",
              "Invalid parameter: Attributes Reason: Topic already exists with different attributes",
            );
          }
        }
      }
      // Check for tag conflicts
      if (tags) {
        const newTags = new Map(Object.entries(tags));
        if (existing.tags.size !== newTags.size) {
          throw new SnsError(
            "InvalidParameter",
            "Invalid parameter: Tags Reason: Topic already exists with different tags",
          );
        }
        for (const [key, value] of newTags) {
          if (existing.tags.get(key) !== value) {
            throw new SnsError(
              "InvalidParameter",
              "Invalid parameter: Tags Reason: Topic already exists with different tags",
            );
          }
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
    return topic;
  }

  deleteTopic(arn: string): boolean {
    const topic = this.topics.get(arn);
    if (!topic) return false;

    // Remove associated subscriptions
    for (const subArn of topic.subscriptionArns) {
      this.subscriptions.delete(subArn);
    }

    this.topics.delete(arn);
    return true;
  }

  getTopic(arn: string): SnsTopic | undefined {
    return this.topics.get(arn);
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

    this.subscriptions.set(arn, subscription);
    topic.subscriptionArns.push(arn);
    return subscription;
  }

  unsubscribe(arn: string): boolean {
    const sub = this.subscriptions.get(arn);
    if (!sub) return false;

    const topic = this.topics.get(sub.topicArn);
    if (topic) {
      topic.subscriptionArns = topic.subscriptionArns.filter((s) => s !== arn);
    }

    this.subscriptions.delete(arn);
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
