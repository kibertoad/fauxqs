import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS Dead Letter Queue", () => {
  let server: FauxqsServer;
  let sqs: ReturnType<typeof createSqsClient>;

  beforeAll(async () => {
    server = await startFauxqsTestServer();
    sqs = createSqsClient(server.port);
  });

  afterAll(async () => {
    sqs.destroy();
    await server.stop();
  });

  it("moves messages to DLQ after maxReceiveCount", async () => {
    // Create DLQ
    const dlq = await sqs.send(
      new CreateQueueCommand({ QueueName: "my-dlq" }),
    );
    const dlqAttrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlq.QueueUrl!,
        AttributeNames: ["QueueArn"],
      }),
    );

    // Create source queue with RedrivePolicy, short visibility timeout
    const source = await sqs.send(
      new CreateQueueCommand({
        QueueName: "source-queue",
        Attributes: { VisibilityTimeout: "1" },
      }),
    );

    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: source.QueueUrl!,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqAttrs.Attributes!.QueueArn,
            maxReceiveCount: 2,
          }),
        },
      }),
    );

    // Send a message
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: source.QueueUrl!,
        MessageBody: "dlq test message",
      }),
    );

    // Receive 1st time
    await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }),
    );
    await new Promise((r) => setTimeout(r, 1200));

    // Receive 2nd time
    await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }),
    );
    await new Promise((r) => setTimeout(r, 1200));

    // 3rd receive should trigger DLQ move (receiveCount now 3 > maxReceiveCount 2)
    const thirdReceive = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }),
    );
    // Message should have been moved to DLQ, so source returns empty
    expect(thirdReceive.Messages).toBeUndefined();

    // Check DLQ has the message
    const dlqMessages = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: dlq.QueueUrl! }),
    );
    expect(dlqMessages.Messages).toHaveLength(1);
    expect(dlqMessages.Messages![0].Body).toBe("dlq test message");
  });

  it("preserves message body and MessageAttributes through DLQ move", async () => {
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: "attr-dlq" }));
    const dlqAttrs = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: dlq.QueueUrl!, AttributeNames: ["QueueArn"],
    }));
    const source = await sqs.send(new CreateQueueCommand({
      QueueName: "attr-src-queue",
      Attributes: { VisibilityTimeout: "1" },
    }));
    await sqs.send(new SetQueueAttributesCommand({
      QueueUrl: source.QueueUrl!,
      Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqAttrs.Attributes!.QueueArn, maxReceiveCount: 1 }) },
    }));
    await sqs.send(new SendMessageCommand({
      QueueUrl: source.QueueUrl!,
      MessageBody: "dlq-attrs-body",
      MessageAttributes: { MyAttr: { DataType: "String", StringValue: "myval" } },
    }));
    // Receive once (count=1), wait for visibility timeout
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }));
    await new Promise(r => setTimeout(r, 1200));
    // Second receive triggers DLQ (count=2 > maxReceiveCount=1)
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }));
    // Check DLQ
    const dlqMsg = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: dlq.QueueUrl!,
      MessageAttributeNames: ["All"],
      AttributeNames: ["ApproximateReceiveCount"],
    }));
    expect(dlqMsg.Messages).toHaveLength(1);
    expect(dlqMsg.Messages![0].Body).toBe("dlq-attrs-body");
    expect(dlqMsg.Messages![0].MessageAttributes?.MyAttr?.StringValue).toBe("myval");
  });

  it("supports chained DLQs — message moves A→B→C", async () => {
    const queueC = await sqs.send(new CreateQueueCommand({ QueueName: "chain-c" }));
    const cArn = (await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: queueC.QueueUrl!, AttributeNames: ["QueueArn"],
    }))).Attributes!.QueueArn;

    const queueB = await sqs.send(new CreateQueueCommand({
      QueueName: "chain-b", Attributes: { VisibilityTimeout: "1" },
    }));
    const bArn = (await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: queueB.QueueUrl!, AttributeNames: ["QueueArn"],
    }))).Attributes!.QueueArn;
    await sqs.send(new SetQueueAttributesCommand({
      QueueUrl: queueB.QueueUrl!,
      Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: cArn, maxReceiveCount: 1 }) },
    }));

    const queueA = await sqs.send(new CreateQueueCommand({
      QueueName: "chain-a", Attributes: { VisibilityTimeout: "1" },
    }));
    await sqs.send(new SetQueueAttributesCommand({
      QueueUrl: queueA.QueueUrl!,
      Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: bArn, maxReceiveCount: 1 }) },
    }));

    await sqs.send(new SendMessageCommand({ QueueUrl: queueA.QueueUrl!, MessageBody: "chain-test" }));
    // A: receive once, wait, receive again → moves to B
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueA.QueueUrl! }));
    await new Promise(r => setTimeout(r, 1200));
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueA.QueueUrl! }));
    // B: receive once, wait, receive again → moves to C
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueB.QueueUrl! }));
    await new Promise(r => setTimeout(r, 1200));
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueB.QueueUrl! }));
    // C should have the message
    const final = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueC.QueueUrl! }));
    expect(final.Messages).toHaveLength(1);
    expect(final.Messages![0].Body).toBe("chain-test");
  });

  it("moves FIFO message with ContentBasedDedup to FIFO DLQ", async () => {
    const ts = Date.now();
    const dlq = await sqs.send(new CreateQueueCommand({
      QueueName: `cbd-dlq-${ts}.fifo`, Attributes: { FifoQueue: "true" },
    }));
    const dlqArn = (await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: dlq.QueueUrl!, AttributeNames: ["QueueArn"],
    }))).Attributes!.QueueArn;
    const source = await sqs.send(new CreateQueueCommand({
      QueueName: `cbd-src-${ts}.fifo`,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true", VisibilityTimeout: "1" },
    }));
    await sqs.send(new SetQueueAttributesCommand({
      QueueUrl: source.QueueUrl!,
      Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 1 }) },
    }));
    await sqs.send(new SendMessageCommand({
      QueueUrl: source.QueueUrl!, MessageBody: "cbd-fifo-dlq", MessageGroupId: "g1",
    }));
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }));
    await new Promise(r => setTimeout(r, 1200));
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }));
    const dlqMsg = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq.QueueUrl! }));
    expect(dlqMsg.Messages).toHaveLength(1);
    expect(dlqMsg.Messages![0].Body).toBe("cbd-fifo-dlq");
  });

  it("clears DLQ association when SetQueueAttributes with empty RedrivePolicy", async () => {
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: "clear-dlq" }));
    const dlqArn = (await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: dlq.QueueUrl!, AttributeNames: ["QueueArn"],
    }))).Attributes!.QueueArn;
    const source = await sqs.send(new CreateQueueCommand({
      QueueName: "clear-dlq-source", Attributes: { VisibilityTimeout: "1" },
    }));
    await sqs.send(new SetQueueAttributesCommand({
      QueueUrl: source.QueueUrl!,
      Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 1 }) },
    }));
    // Verify RedrivePolicy is set
    let attrs = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: source.QueueUrl!, AttributeNames: ["RedrivePolicy"],
    }));
    expect(attrs.Attributes?.RedrivePolicy).toBeDefined();
    // Clear RedrivePolicy
    await sqs.send(new SetQueueAttributesCommand({
      QueueUrl: source.QueueUrl!, Attributes: { RedrivePolicy: "" },
    }));
    // Verify cleared
    attrs = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: source.QueueUrl!, AttributeNames: ["All"],
    }));
    expect(attrs.Attributes?.RedrivePolicy).toBeUndefined();
    // Messages should no longer route to DLQ
    await sqs.send(new SendMessageCommand({ QueueUrl: source.QueueUrl!, MessageBody: "no-dlq" }));
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }));
    await new Promise(r => setTimeout(r, 1200));
    const second = await sqs.send(new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }));
    expect(second.Messages).toHaveLength(1);
    expect(second.Messages![0].Body).toBe("no-dlq");
    // DLQ should be empty
    const dlqMsg = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq.QueueUrl! }));
    expect(dlqMsg.Messages).toBeUndefined();
  });
});
