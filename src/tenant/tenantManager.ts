import { sqsQueueArn, snsTopicArn } from "../common/arnHelper.ts";
import { applyInitConfig } from "../initConfig.ts";
import type { FauxqsInitConfig, SetupResult } from "../initConfig.ts";
import type { SqsStore } from "../sqs/sqsStore.ts";
import type { SnsStore } from "../sns/snsStore.ts";
import type { S3Store } from "../s3/s3Store.ts";
import { UsageTracker } from "./usageTracker.ts";
import type { TenantConfig, TemplateRequest } from "./tenantTypes.ts";

const DEFAULT_ADMIN_QUEUE_NAME = "_fauxqs-admin";
const DEFAULT_SWEEP_BUDGET = 50;
const ADMIN_POLL_INTERVAL_MS = 500;
const MIN_SWEEP_INTERVAL_MS = 50;

export class TenantManager {
  readonly usageTracker: UsageTracker;

  private readonly config: TenantConfig;
  private readonly sqsStore: SqsStore;
  private readonly snsStore: SnsStore;
  private readonly s3Store: S3Store;
  private readonly region: string;
  private port: number;
  private readonly template: FauxqsInitConfig | undefined;
  private readonly permanentPrefixes: Set<string>;
  private readonly sweepBudget: number;
  private readonly adminQueueName: string | undefined;

  private readonly instantiatedPrefixes = new Set<string>();
  private sweepCursor: string | undefined;
  private pendingExpired = new Map<string | null, Set<string>>();
  private sweepTimer?: ReturnType<typeof setTimeout>;
  private sweepIntervalMs = 0;
  private sweepRunning = false;
  private adminPollTimer?: ReturnType<typeof setInterval>;

  constructor(
    config: TenantConfig,
    sqsStore: SqsStore,
    snsStore: SnsStore,
    s3Store: S3Store,
    usageTracker: UsageTracker,
    context: { region: string; port: number },
    template?: FauxqsInitConfig,
  ) {
    this.config = config;
    this.sqsStore = sqsStore;
    this.snsStore = snsStore;
    this.s3Store = s3Store;
    this.usageTracker = usageTracker;
    this.region = context.region;
    this.port = context.port;
    this.template = config.template ?? template;
    this.permanentPrefixes = new Set(config.permanentPrefixes ?? []);
    this.sweepBudget = config.sweepBudget ?? DEFAULT_SWEEP_BUDGET;

    // Resolve admin queue name
    if (config.adminQueue === true) {
      this.adminQueueName = DEFAULT_ADMIN_QUEUE_NAME;
    } else if (typeof config.adminQueue === "string") {
      this.adminQueueName = config.adminQueue;
    }
  }

  /** Update the port after the server starts listening. Must be called before start(). */
  setPort(port: number): void {
    this.port = port;
  }

  /** Start sweep timer and admin queue polling (if enabled). */
  start(): void {
    // Start sweep timer — uses setTimeout chain instead of setInterval so the next
    // tick only starts after the previous one finishes (backpressure).
    this.sweepIntervalMs = Math.max(
      this.config.sweepIntervalMs ?? Math.floor(this.config.ttlMs / 10),
      MIN_SWEEP_INTERVAL_MS,
    );
    this.sweepRunning = true;
    this.scheduleSweep();

    // Create and start polling the admin queue if enabled
    if (this.adminQueueName) {
      this.createAdminQueue();
      this.adminPollTimer = setInterval(() => this.pollAdminQueue(), ADMIN_POLL_INTERVAL_MS);
    }
  }

  /** Reset all tenant state (called on purgeAll). */
  reset(): void {
    this.usageTracker.clear();
    this.instantiatedPrefixes.clear();
    this.pendingExpired.clear();
    this.sweepCursor = undefined;
    // Recreate admin queue if it was enabled (purgeAll wipes all queues)
    if (this.adminQueueName) {
      this.createAdminQueue();
    }
  }

  /** Stop all timers. */
  shutdown(): void {
    this.sweepRunning = false;
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    if (this.adminPollTimer) {
      clearInterval(this.adminPollTimer);
      this.adminPollTimer = undefined;
    }
  }

  /** Instantiate the template with a given prefix. Idempotent. */
  instantiateTemplate(prefix: string): SetupResult {
    if (!this.template) {
      throw new Error("No template configured for tenant instantiation");
    }

    // If prefix already exists, just bump usage timestamps
    if (this.instantiatedPrefixes.has(prefix)) {
      this.touchAllInPrefix(prefix);
      return { queues: [], topics: [], subscriptions: [], buckets: [] };
    }

    const prefixedConfig = this.prefixConfig(this.template, prefix);
    const result = applyInitConfig(prefixedConfig, this.sqsStore, this.snsStore, this.s3Store, {
      port: this.port,
      region: this.region,
    });

    // Register all created resources with explicit prefix in the usage tracker
    this.registerTemplateResources(prefix);
    this.instantiatedPrefixes.add(prefix);

    return result;
  }

  /** List all instantiated prefixes with their oldest last-used timestamp. */
  listTenants(): Array<{ prefix: string; lastUsedMs: number }> {
    const result: Array<{ prefix: string; lastUsedMs: number }> = [];
    for (const prefix of this.instantiatedPrefixes) {
      let oldestMs = Date.now();
      const names = this.getResourceNamesForPrefix(prefix);
      for (const name of names) {
        const entry = this.usageTracker.get(name);
        if (entry && entry.lastUsedMs < oldestMs) {
          oldestMs = entry.lastUsedMs;
        }
      }
      result.push({ prefix, lastUsedMs: oldestMs });
    }
    return result;
  }

  /** Force-delete all resources for a given prefix. */
  deleteTenant(prefix: string): void {
    if (!this.instantiatedPrefixes.has(prefix)) return;
    this.deleteResourceSet(prefix);
    this.instantiatedPrefixes.delete(prefix);
    this.pendingExpired.delete(prefix);
  }

  // --- Private: Sweep ---

  private scheduleSweep(): void {
    if (!this.sweepRunning) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTick();
      this.scheduleSweep();
    }, this.sweepIntervalMs);
  }

  private sweepTick(): void {
    const cutoff = Date.now() - this.config.ttlMs;
    const { visited, nextCursor, wrapped } = this.usageTracker.scan(
      this.sweepCursor,
      this.sweepBudget,
    );
    this.sweepCursor = nextCursor;

    for (const [name, entry] of visited) {
      if (entry.lastUsedMs >= cutoff) {
        // Not expired — remove from pending if it was there
        this.removePendingEntry(entry.prefix, name);
        continue;
      }

      // Check permanent status
      if (this.isResourcePermanent(name, entry.prefix)) continue;

      // Add to pending expired
      let pending = this.pendingExpired.get(entry.prefix);
      if (!pending) {
        pending = new Set();
        this.pendingExpired.set(entry.prefix, pending);
      }
      pending.add(name);
    }

    // Only process deletions after a full cycle (wrapped around)
    if (wrapped) {
      this.processPendingDeletions();
    }
  }

  private processPendingDeletions(): void {
    const toDelete: Array<string | null> = [];
    const deletedNames = new Set<string>();

    for (const [prefix, pendingNames] of this.pendingExpired) {
      if (prefix === null) {
        for (const name of pendingNames) {
          this.deleteIndividualResource(name);
          deletedNames.add(name);
        }
        toDelete.push(prefix);
        continue;
      }

      const expectedNames = this.getResourceNamesForPrefix(prefix);
      const allExpired = expectedNames.every((n) => pendingNames.has(n));
      if (allExpired) {
        this.deleteResourceSet(prefix);
        this.instantiatedPrefixes.delete(prefix);
        for (const name of pendingNames) deletedNames.add(name);
        toDelete.push(prefix);
      }
    }

    for (const prefix of toDelete) {
      this.pendingExpired.delete(prefix);
    }

    // Only reset cursor if it pointed to a deleted entry — avoids restarting
    // the scan from the beginning when unrelated prefixes were cleaned up.
    if (this.sweepCursor && deletedNames.has(this.sweepCursor)) {
      this.sweepCursor = undefined;
    }
  }

  private isResourcePermanent(name: string, prefix: string | null): boolean {
    // Admin queue is always permanent
    if (this.adminQueueName && name === this.adminQueueName) return true;
    if (prefix === null) {
      return this.permanentPrefixes.has("");
    }
    return this.permanentPrefixes.has(prefix);
  }

  private removePendingEntry(prefix: string | null, name: string): void {
    const pending = this.pendingExpired.get(prefix);
    if (pending) {
      pending.delete(name);
      if (pending.size === 0) {
        this.pendingExpired.delete(prefix);
      }
    }
  }

  // --- Private: Resource deletion ---

  private deleteResourceSet(prefix: string): void {
    if (!this.template) return;

    // 1. Remove subscriptions first
    if (this.template.subscriptions) {
      for (const sub of this.template.subscriptions) {
        const topicArn = snsTopicArn(prefix + sub.topic, this.region);
        const queueArn = sqsQueueArn(prefix + sub.queue, this.region);
        this.removeSubscription(topicArn, queueArn);
      }
    }

    // 2. Delete topics
    if (this.template.topics) {
      for (const t of this.template.topics) {
        const fullName = prefix + t.name;
        const arn = snsTopicArn(fullName, this.region);
        try {
          this.snsStore.deleteTopic(arn);
        } catch {
          // Topic may already be deleted
        }
        this.usageTracker.delete(fullName);
      }
    }

    // 3. Delete queues
    if (this.template.queues) {
      for (const q of this.template.queues) {
        const fullName = prefix + q.name;
        try {
          const queue = this.sqsStore.getQueueByName(fullName);
          if (queue) {
            queue.cancelWaiters();
            this.sqsStore.deleteQueue(queue.url);
          }
        } catch {
          // Queue may already be deleted
        }
        this.usageTracker.delete(fullName);
      }
    }

    // 4. Empty and delete buckets
    if (this.template.buckets) {
      for (const entry of this.template.buckets) {
        const baseName = typeof entry === "string" ? entry : entry.name;
        const fullName = prefix + baseName;
        this.s3Store.emptyBucket(fullName);
        try {
          this.s3Store.deleteBucket(fullName);
        } catch {
          // Bucket may not exist or may have concurrent uploads — skip, retry next cycle
        }
        this.usageTracker.delete(fullName);
      }
    }
  }

  private deleteIndividualResource(name: string): void {
    // Try to find and delete the resource by name across all stores.
    // Queue and bucket lookups are O(1). Topic uses ARN construction
    // with the known region to avoid O(n) scan over all topics.
    const queue = this.sqsStore.getQueueByName(name);
    if (queue) {
      queue.cancelWaiters();
      this.sqsStore.deleteQueue(queue.url);
      this.usageTracker.delete(name);
      return;
    }

    const topicArn = snsTopicArn(name, this.region);
    if (this.snsStore.getTopic(topicArn)) {
      this.snsStore.deleteTopic(topicArn);
      this.usageTracker.delete(name);
      return;
    }

    if (this.s3Store.hasBucket(name)) {
      this.s3Store.emptyBucket(name);
      try {
        this.s3Store.deleteBucket(name);
      } catch {
        // Skip on error
      }
      this.usageTracker.delete(name);
    }
  }

  private removeSubscription(topicArn: string, queueArn: string): void {
    // Find the subscription matching this topic+queue pair
    for (const [subArn, sub] of this.snsStore.subscriptions) {
      if (sub.topicArn === topicArn && sub.endpoint === queueArn) {
        this.snsStore.unsubscribe(subArn);
        return;
      }
    }
  }

  // --- Private: Template helpers ---

  private prefixConfig(config: FauxqsInitConfig, prefix: string): FauxqsInitConfig {
    return {
      region: config.region,
      queues: config.queues?.map((q) => ({
        ...q,
        name: prefix + q.name,
        attributes: q.attributes ? this.prefixQueueAttributes(q.attributes, prefix) : undefined,
      })),
      topics: config.topics?.map((t) => ({ ...t, name: prefix + t.name })),
      subscriptions: config.subscriptions?.map((s) => ({
        ...s,
        topic: prefix + s.topic,
        queue: prefix + s.queue,
      })),
      buckets: config.buckets?.map((b) =>
        typeof b === "string" ? prefix + b : { ...b, name: prefix + b.name },
      ),
    };
  }

  /** Rewrite ARNs inside RedrivePolicy so DLQ references point to the prefixed queue. */
  private prefixQueueAttributes(
    attrs: Record<string, string>,
    prefix: string,
  ): Record<string, string> {
    if (!attrs.RedrivePolicy) return attrs;
    try {
      const policy = JSON.parse(attrs.RedrivePolicy);
      if (typeof policy.deadLetterTargetArn === "string") {
        // ARN format: arn:aws:sqs:region:account:queueName — prefix the queue name portion
        const parts = policy.deadLetterTargetArn.split(":");
        if (parts.length === 6) {
          parts[5] = prefix + parts[5];
          policy.deadLetterTargetArn = parts.join(":");
        }
      }
      return { ...attrs, RedrivePolicy: JSON.stringify(policy) };
    } catch {
      return attrs;
    }
  }

  private registerTemplateResources(prefix: string): void {
    if (!this.template) return;

    for (const q of this.template.queues ?? []) {
      this.usageTracker.register(prefix + q.name, prefix);
    }
    for (const t of this.template.topics ?? []) {
      this.usageTracker.register(prefix + t.name, prefix);
    }
    for (const entry of this.template.buckets ?? []) {
      const name = typeof entry === "string" ? entry : entry.name;
      this.usageTracker.register(prefix + name, prefix);
    }
  }

  private touchAllInPrefix(prefix: string): void {
    const names = this.getResourceNamesForPrefix(prefix);
    for (const name of names) {
      this.usageTracker.touch(name);
    }
  }

  private getResourceNamesForPrefix(prefix: string): string[] {
    if (!this.template) return [];
    const names: string[] = [];
    for (const q of this.template.queues ?? []) {
      names.push(prefix + q.name);
    }
    for (const t of this.template.topics ?? []) {
      names.push(prefix + t.name);
    }
    for (const entry of this.template.buckets ?? []) {
      const name = typeof entry === "string" ? entry : entry.name;
      names.push(prefix + name);
    }
    return names;
  }

  // --- Private: Admin queue ---

  private createAdminQueue(): void {
    if (!this.adminQueueName) return;
    const existing = this.sqsStore.getQueueByName(this.adminQueueName);
    if (existing) return;

    const defaultHost = `127.0.0.1:${this.port}`;
    const arn = sqsQueueArn(this.adminQueueName, this.region);
    const url = this.sqsStore.buildQueueUrl(
      this.adminQueueName,
      String(this.port),
      defaultHost,
      this.region,
    );
    this.sqsStore.createQueue(this.adminQueueName, url, arn);
    // Register as non-tenant-managed; always exempt from cleanup via isResourcePermanent()
    this.usageTracker.register(this.adminQueueName, null);
  }

  private pollAdminQueue(): void {
    if (!this.adminQueueName) return;
    const queue = this.sqsStore.getQueueByName(this.adminQueueName);
    if (!queue) return;

    const messages = queue.dequeue(10);
    for (const msg of messages) {
      try {
        const request = JSON.parse(msg.Body) as TemplateRequest;
        if (request.action === "instantiate" && typeof request.prefix === "string") {
          this.instantiateTemplate(request.prefix);
        }
      } catch {
        // Invalid message — consume and discard
      }
      // Always delete the message (acknowledge)
      queue.inflightMessages.delete(msg.ReceiptHandle);
    }
  }
}
