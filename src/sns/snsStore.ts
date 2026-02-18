import { randomUUID } from "node:crypto";
import { snsTopicArn, snsSubscriptionArn } from "../common/arnHelper.js";
import type { SnsTopic, SnsSubscription } from "./snsTypes.js";

export class SnsStore {
  topics = new Map<string, SnsTopic>();
  subscriptions = new Map<string, SnsSubscription>();
  region?: string;

  createTopic(
    name: string,
    attributes?: Record<string, string>,
    tags?: Record<string, string>,
  ): SnsTopic {
    const arn = snsTopicArn(name, this.region);

    const existing = this.topics.get(arn);
    if (existing) return existing;

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

  listTopics(): SnsTopic[] {
    return Array.from(this.topics.values());
  }

  subscribe(
    topicArn: string,
    protocol: string,
    endpoint: string,
    attributes?: Record<string, string>,
  ): SnsSubscription | undefined {
    const topic = this.topics.get(topicArn);
    if (!topic) return undefined;

    const id = randomUUID();
    const arn = snsSubscriptionArn(topic.name, id, this.region);

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

  listSubscriptions(): SnsSubscription[] {
    return Array.from(this.subscriptions.values());
  }

  listSubscriptionsByTopic(topicArn: string): SnsSubscription[] {
    const topic = this.topics.get(topicArn);
    if (!topic) return [];
    return topic.subscriptionArns
      .map((arn) => this.subscriptions.get(arn))
      .filter((s): s is SnsSubscription => s !== undefined);
  }
}
