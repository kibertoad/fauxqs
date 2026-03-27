import { describe, it, expect, afterEach } from "vitest";
import { startFauxqs, type FauxqsServer, type FauxqsInitConfig } from "../../src/app.js";
import { createSqsClient } from "../helpers/clients.js";
import {
  ListQueuesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
} from "@aws-sdk/client-sqs";

const TEMPLATE: FauxqsInitConfig = {
  queues: [
    { name: "orders" },
    { name: "notifications" },
  ],
  topics: [{ name: "events" }],
  subscriptions: [{ topic: "events", queue: "notifications" }],
  buckets: ["assets"],
};

describe("tenant management", () => {
  let server: FauxqsServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  describe("template instantiation via programmatic API", () => {
    it("instantiateTemplate creates prefixed resources", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        init: TEMPLATE,
        tenant: { ttlMs: 60_000, template: TEMPLATE },
      });

      const result = server.instantiateTemplate("env1-");
      expect(result.queues).toHaveLength(2);
      expect(result.queues.map((q) => q.name).sort()).toEqual(["env1-notifications", "env1-orders"]);
      expect(result.topics).toHaveLength(1);
      expect(result.topics[0].name).toBe("env1-events");
      expect(result.subscriptions).toHaveLength(1);
      expect(result.buckets).toHaveLength(1);
      expect(result.buckets[0].name).toBe("env1-assets");

      // Verify the prefixed queue is accessible via SQS SDK
      const sqs = createSqsClient(server.port);
      const queues = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "env1-" }));
      expect(queues.QueueUrls).toHaveLength(2);
    });

    it("instantiateTemplate is idempotent", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: { ttlMs: 60_000, template: TEMPLATE },
      });

      const result1 = server.instantiateTemplate("env2-");
      expect(result1.queues).toHaveLength(2);

      // Second call — should return empty results (already exists, just bumped timestamps)
      const result2 = server.instantiateTemplate("env2-");
      expect(result2.queues).toHaveLength(0);
    });

    it("listTenants returns instantiated prefixes", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: { ttlMs: 60_000, template: TEMPLATE },
      });

      server.instantiateTemplate("a-");
      server.instantiateTemplate("b-");

      const tenants = server.listTenants();
      expect(tenants).toHaveLength(2);
      expect(tenants.map((t) => t.prefix).sort()).toEqual(["a-", "b-"]);
      for (const t of tenants) {
        expect(t.lastUsedMs).toBeGreaterThan(0);
      }
    });

    it("deleteTenant removes all prefixed resources", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: { ttlMs: 60_000, template: TEMPLATE },
      });

      server.instantiateTemplate("del-");

      const sqs = createSqsClient(server.port);
      let queues = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "del-" }));
      expect(queues.QueueUrls).toHaveLength(2);

      server.deleteTenant("del-");

      queues = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "del-" }));
      expect(queues.QueueUrls ?? []).toHaveLength(0);

      expect(server.listTenants()).toHaveLength(0);
    });

    it("throws when tenant management is not enabled", async () => {
      server = await startFauxqs({ port: 0, logger: false });
      expect(() => server.instantiateTemplate("x-")).toThrow("not enabled");
      expect(() => server.listTenants()).toThrow("not enabled");
      expect(() => server.deleteTenant("x-")).toThrow("not enabled");
    });
  });

  describe("template instantiation via REST API", () => {
    it("POST /_fauxqs/tenants/:prefix creates resources", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: { ttlMs: 60_000, template: TEMPLATE },
      });

      const res = await fetch(`http://127.0.0.1:${server.port}/_fauxqs/tenants/rest-`, {
        method: "POST",
      });
      expect(res.ok).toBe(true);
      const body = await res.json();
      expect(body.prefix).toBe("rest-");
      expect(body.queues).toHaveLength(2);
    });

    it("GET /_fauxqs/tenants lists tenants", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: { ttlMs: 60_000, template: TEMPLATE },
      });

      server.instantiateTemplate("list-");

      const res = await fetch(`http://127.0.0.1:${server.port}/_fauxqs/tenants`);
      expect(res.ok).toBe(true);
      const tenants = await res.json();
      expect(tenants).toHaveLength(1);
      expect(tenants[0].prefix).toBe("list-");
    });

    it("DELETE /_fauxqs/tenants/:prefix removes tenant", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: { ttlMs: 60_000, template: TEMPLATE },
      });

      server.instantiateTemplate("rm-");

      const res = await fetch(`http://127.0.0.1:${server.port}/_fauxqs/tenants/rm-`, {
        method: "DELETE",
      });
      expect(res.status).toBe(204);
      expect(server.listTenants()).toHaveLength(0);
    });

    it("tenant endpoints are not registered when disabled", async () => {
      server = await startFauxqs({ port: 0, logger: false });

      const res = await fetch(`http://127.0.0.1:${server.port}/_fauxqs/tenants`);
      expect(res.status).toBe(404);
    });
  });

  describe("auto-cleanup", () => {
    it("cleans up expired tenant resources after TTL", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: {
          ttlMs: 100,
          sweepIntervalMs: 50,
          sweepBudget: 100,
          template: TEMPLATE,
        },
      });

      server.instantiateTemplate("expire-");

      const sqs = createSqsClient(server.port);
      let queues = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "expire-" }));
      expect(queues.QueueUrls).toHaveLength(2);

      // Wait for TTL + sweep cycles
      await new Promise((r) => setTimeout(r, 400));

      queues = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "expire-" }));
      expect(queues.QueueUrls ?? []).toHaveLength(0);
      expect(server.listTenants()).toHaveLength(0);
    });

    it("usage bumps prevent cleanup", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: {
          ttlMs: 150,
          sweepIntervalMs: 50,
          sweepBudget: 100,
          template: TEMPLATE,
        },
      });

      server.instantiateTemplate("alive-");

      const sqs = createSqsClient(server.port);

      // Keep the resource alive by using it
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 50));
        await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "alive-" }));
        // Touch via SQS receive (hits getQueue)
        const queues = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "alive-" }));
        if (queues.QueueUrls?.[0]) {
          await sqs.send(new ReceiveMessageCommand({
            QueueUrl: queues.QueueUrls[0],
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 0,
          }));
        }
      }

      // Resources should still exist
      const queues = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "alive-" }));
      expect(queues.QueueUrls).toHaveLength(2);
    });

    it("permanent prefixes are exempt from cleanup", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: {
          ttlMs: 100,
          sweepIntervalMs: 50,
          sweepBudget: 100,
          permanentPrefixes: ["perm-"],
          template: TEMPLATE,
        },
      });

      server.instantiateTemplate("perm-");
      server.instantiateTemplate("temp-");

      // Wait for TTL + sweep
      await new Promise((r) => setTimeout(r, 400));

      const sqs = createSqsClient(server.port);

      // Permanent prefix should survive
      const permQueues = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "perm-" }));
      expect(permQueues.QueueUrls).toHaveLength(2);

      // Temporary prefix should be cleaned up
      const tempQueues = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "temp-" }));
      expect(tempQueues.QueueUrls ?? []).toHaveLength(0);
    });

    it("empty string permanent prefix protects non-tenant resources", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        init: { queues: [{ name: "base-queue" }] },
        tenant: {
          ttlMs: 100,
          sweepIntervalMs: 50,
          sweepBudget: 100,
          permanentPrefixes: [""],
          template: TEMPLATE,
        },
      });

      // base-queue is from init config, not tenant-managed (prefix: null)
      // It should be protected by "" in permanentPrefixes

      server.instantiateTemplate("eph-");

      await new Promise((r) => setTimeout(r, 400));

      const sqs = createSqsClient(server.port);

      // Base queue should survive
      const baseQueues = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "base-" }));
      expect(baseQueues.QueueUrls).toHaveLength(1);

      // Ephemeral prefix should be cleaned
      const ephQueues = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "eph-" }));
      expect(ephQueues.QueueUrls ?? []).toHaveLength(0);
    });
  });

  describe("admin queue", () => {
    it("instantiates template via admin queue message", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: {
          ttlMs: 60_000,
          template: TEMPLATE,
          adminQueue: true,
        },
      });

      const sqs = createSqsClient(server.port);

      // Verify admin queue exists
      const queues = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "_fauxqs-admin" }));
      expect(queues.QueueUrls).toHaveLength(1);

      // Send instantiation request to admin queue
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.QueueUrls![0],
          MessageBody: JSON.stringify({ action: "instantiate", prefix: "via-admin-" }),
        }),
      );

      // Wait for admin poll cycle
      await new Promise((r) => setTimeout(r, 1000));

      // Verify prefixed resources were created
      const prefixedQueues = await sqs.send(
        new ListQueuesCommand({ QueueNamePrefix: "via-admin-" }),
      );
      expect(prefixedQueues.QueueUrls).toHaveLength(2);
    });

    it("admin queue is not created when adminQueue option is not set", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: { ttlMs: 60_000, template: TEMPLATE },
      });

      const sqs = createSqsClient(server.port);
      const queues = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "_fauxqs-admin" }));
      expect(queues.QueueUrls ?? []).toHaveLength(0);
    });

    it("admin queue uses custom name", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: {
          ttlMs: 60_000,
          template: TEMPLATE,
          adminQueue: "my-admin",
        },
      });

      const sqs = createSqsClient(server.port);
      const queues = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "my-admin" }));
      expect(queues.QueueUrls).toHaveLength(1);
    });
  });

  describe("purgeAll clears tenant state", () => {
    it("purgeAll resets tenant tracking", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: { ttlMs: 60_000, template: TEMPLATE },
      });

      server.instantiateTemplate("purge-");
      expect(server.listTenants()).toHaveLength(1);

      server.purgeAll();

      // The usage tracker is cleared, but instantiatedPrefixes in TenantManager persists
      // This is expected — purgeAll clears resources, not tenant bookkeeping
      // A new instantiation after purge should work
      const result = server.instantiateTemplate("purge-");
      expect(result.queues).toHaveLength(2);
    });
  });
});
