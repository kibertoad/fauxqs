import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  ListQueuesCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "./helpers/clients.js";
import { startFauxqs, type FauxqsServer } from "../src/app.js";

describe("applyInitConfig idempotency", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startFauxqs({
      port: 0,
      logger: false,
      init: {
        queues: [{ name: "init-idem-queue" }],
      },
    });
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("does not overwrite queue with messages when init config is reapplied", async () => {
    const list = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: "init-idem-queue" }));
    const queueUrl = list.QueueUrls![0];

    await sqs.send(
      new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "important" }),
    );

    // Re-apply the same init config
    server.setup({ queues: [{ name: "init-idem-queue" }] });

    // Queue was not recreated — message is still there
    const state = server.inspectQueue("init-idem-queue");
    expect(state).toBeDefined();
    expect(state!.messages.ready).toHaveLength(1);
    expect(state!.messages.ready[0].body).toBe("important");
  });
});
