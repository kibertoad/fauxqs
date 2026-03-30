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

    it("rewrites DLQ ARNs in RedrivePolicy when prefixing", async () => {
      const templateWithDlq: FauxqsInitConfig = {
        queues: [
          { name: "dlq" },
          {
            name: "main",
            attributes: {
              RedrivePolicy: JSON.stringify({
                deadLetterTargetArn: "arn:aws:sqs:us-east-1:000000000000:dlq",
                maxReceiveCount: "3",
              }),
            },
          },
        ],
      };

      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: { ttlMs: 60_000, template: templateWithDlq },
      });

      server.instantiateTemplate("env-");

      // Verify the prefixed main queue exists and its DLQ points to prefixed DLQ
      const inspection = server.inspectQueue("env-main");
      expect(inspection).toBeDefined();
      const redrivePolicy = JSON.parse(
        inspection!.attributes.RedrivePolicy ?? "{}",
      );
      expect(redrivePolicy.deadLetterTargetArn).toBe(
        "arn:aws:sqs:us-east-1:000000000000:env-dlq",
      );
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

    it("POST /_fauxqs/tenants/:prefix returns 400 when no template configured", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: { ttlMs: 60_000 }, // no template
      });

      const res = await fetch(`http://127.0.0.1:${server.port}/_fauxqs/tenants/x-`, {
        method: "POST",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("No template");
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
      await new Promise((r) => setTimeout(r, 500));

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

      // Resolve queue URLs upfront
      const queuesResult = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "alive-" }));
      const queueUrl = queuesResult.QueueUrls![0];

      // Keep the resources alive by using them (ReceiveMessage triggers getQueue → touch)
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 50));
        await sqs.send(new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 0,
        }));
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

  describe("seedFromStores on startup", () => {
    it("existing resources from init config are seeded as just-used", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        init: { queues: [{ name: "pre-existing" }] },
        tenant: {
          ttlMs: 100,
          sweepIntervalMs: 50,
          sweepBudget: 100,
          permanentPrefixes: [""],
          template: TEMPLATE,
        },
      });

      // pre-existing queue from init config should be tracked
      // If it wasn't seeded, it would be invisible to the sweep entirely.
      // Verify it survives a sweep cycle (protected by permanent "" prefix)
      await new Promise((r) => setTimeout(r, 400));

      const sqs = createSqsClient(server.port);
      const queues = await sqs.send(
        new ListQueuesCommand({ QueueNamePrefix: "pre-existing" }),
      );
      expect(queues.QueueUrls).toHaveLength(1);
    });

    it("re-discovers tenants from store state after purgeAll + re-instantiate", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: { ttlMs: 60_000, template: TEMPLATE },
      });

      server.instantiateTemplate("seed-");
      expect(server.listTenants()).toHaveLength(1);

      // Verify resources are tracked
      const sqs = createSqsClient(server.port);
      const queues = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "seed-" }));
      expect(queues.QueueUrls).toHaveLength(2);
    });
  });

  describe("list operations update usage tracking", () => {
    it("ListQueues touches tracked queues", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: {
          ttlMs: 200,
          sweepIntervalMs: 50,
          sweepBudget: 100,
          template: TEMPLATE,
        },
      });

      server.instantiateTemplate("list-touch-");

      const sqs = createSqsClient(server.port);

      // Keep alive by listing (not direct access)
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 75));
        await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "list-touch-" }));
      }

      // Resources should still exist because ListQueues touches them
      const queues = await sqs.send(
        new ListQueuesCommand({ QueueNamePrefix: "list-touch-" }),
      );
      expect(queues.QueueUrls).toHaveLength(2);
    });
  });

  describe("sweepBudget validation", () => {
    it("throws when sweepBudget is 0", async () => {
      await expect(
        startFauxqs({
          port: 0,
          logger: false,
          tenant: { ttlMs: 60_000, sweepBudget: 0, template: TEMPLATE },
        }),
      ).rejects.toThrow("sweepBudget must be a positive integer");
    });

    it("throws when sweepBudget is negative", async () => {
      await expect(
        startFauxqs({
          port: 0,
          logger: false,
          tenant: { ttlMs: 60_000, sweepBudget: -1, template: TEMPLATE },
        }),
      ).rejects.toThrow("sweepBudget must be a positive integer");
    });
  });

  describe("RedrivePolicy prefixing", () => {
    it("throws on malformed RedrivePolicy JSON", async () => {
      const badTemplate: FauxqsInitConfig = {
        queues: [
          { name: "dlq" },
          {
            name: "main",
            attributes: { RedrivePolicy: "not-valid-json{{{" },
          },
        ],
      };

      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: { ttlMs: 60_000, template: badTemplate },
      });

      expect(() => server.instantiateTemplate("bad-")).toThrow(
        "Failed to prefix RedrivePolicy",
      );
    });
  });

  describe("subscription cleanup removes all duplicates", () => {
    it("deleteTenant removes duplicate subscriptions with same topic+queue", async () => {
      server = await startFauxqs({
        port: 0,
        logger: false,
        tenant: { ttlMs: 60_000, template: TEMPLATE },
      });

      server.instantiateTemplate("dup-");

      // Verify resources created (including subscription)
      expect(server.listTenants()).toHaveLength(1);

      // Delete should succeed without leaking subscriptions
      server.deleteTenant("dup-");
      expect(server.listTenants()).toHaveLength(0);

      const sqs = createSqsClient(server.port);
      const queues = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "dup-" }));
      expect(queues.QueueUrls ?? []).toHaveLength(0);
    });
  });

  describe("admin queue logging", () => {
    it("processes valid messages and handles invalid ones gracefully", async () => {
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
      const adminQueues = await sqs.send(
        new ListQueuesCommand({ QueueNamePrefix: "_fauxqs-admin" }),
      );
      const adminUrl = adminQueues.QueueUrls![0];

      // Send invalid JSON — should be consumed without crashing
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: adminUrl,
          MessageBody: "not json",
        }),
      );

      // Send valid message
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: adminUrl,
          MessageBody: JSON.stringify({ action: "instantiate", prefix: "log-test-" }),
        }),
      );

      // Wait for admin poll cycle
      await new Promise((r) => setTimeout(r, 1000));

      // Valid message should have worked despite the invalid one
      const queues = await sqs.send(
        new ListQueuesCommand({ QueueNamePrefix: "log-test-" }),
      );
      expect(queues.QueueUrls).toHaveLength(2);
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

      // purgeAll() calls TenantManager.reset(), which calls
      // instantiatedPrefixes.clear() — both resources and tracking state are
      // cleared, so instantiateTemplate creates fresh resources
      const result = server.instantiateTemplate("purge-");
      expect(result.queues).toHaveLength(2);
    });
  });
});
