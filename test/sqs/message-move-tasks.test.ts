import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  SetQueueAttributesCommand,
  GetQueueAttributesCommand,
  ListDeadLetterSourceQueuesCommand,
  StartMessageMoveTaskCommand,
  ListMessageMoveTasksCommand,
  CancelMessageMoveTaskCommand,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../helpers/clients.js";
import { startFauxqsTestServer, type FauxqsServer } from "../helpers/setup.js";

describe("SQS DLQ redrive (message move tasks)", () => {
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

  async function arnOf(queueUrl: string): Promise<string> {
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }),
    );
    return attrs.Attributes!.QueueArn!;
  }

  it("ListDeadLetterSourceQueues returns queues wired to the DLQ", async () => {
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: "ldlsq-dlq" }));
    const dlqArn = await arnOf(dlq.QueueUrl!);

    const src1 = await sqs.send(new CreateQueueCommand({ QueueName: "ldlsq-src-1" }));
    const src2 = await sqs.send(new CreateQueueCommand({ QueueName: "ldlsq-src-2" }));
    const unrelated = await sqs.send(new CreateQueueCommand({ QueueName: "ldlsq-unrelated" }));

    for (const url of [src1.QueueUrl!, src2.QueueUrl!]) {
      await sqs.send(
        new SetQueueAttributesCommand({
          QueueUrl: url,
          Attributes: {
            RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 3 }),
          },
        }),
      );
    }

    const result = await sqs.send(
      new ListDeadLetterSourceQueuesCommand({ QueueUrl: dlq.QueueUrl! }),
    );

    expect(result.queueUrls).toHaveLength(2);
    expect(result.queueUrls).toEqual(
      expect.arrayContaining([src1.QueueUrl, src2.QueueUrl]),
    );
    expect(result.queueUrls).not.toContain(unrelated.QueueUrl);
  });

  it("redrives dead-lettered messages back to their origin queue", async () => {
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: "redrive-dlq" }));
    const dlqArn = await arnOf(dlq.QueueUrl!);

    const source = await sqs.send(new CreateQueueCommand({ QueueName: "redrive-source" }));
    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: source.QueueUrl!,
        Attributes: {
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 1 }),
        },
      }),
    );

    await sqs.send(
      new SendMessageCommand({ QueueUrl: source.QueueUrl!, MessageBody: "redrive-me" }),
    );

    // Receive twice (VisibilityTimeout 0 makes the message immediately re-visible);
    // the second receive exceeds maxReceiveCount=1 and moves it to the DLQ.
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: source.QueueUrl!, VisibilityTimeout: 0 }));
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: source.QueueUrl!, VisibilityTimeout: 0 }));

    // Start a redrive task with no DestinationArn — messages return to the source queue.
    const task = await sqs.send(new StartMessageMoveTaskCommand({ SourceArn: dlqArn }));
    expect(task.TaskHandle).toBeDefined();

    // The redrive is synchronous, so the message is already back in the source queue.
    const backInSource = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: source.QueueUrl! }),
    );
    expect(backInSource.Messages).toHaveLength(1);
    expect(backInSource.Messages![0].Body).toBe("redrive-me");

    // The DLQ is now empty.
    const dlqLeft = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq.QueueUrl! }));
    expect(dlqLeft.Messages).toBeUndefined();
  });

  it("redrives to an explicit DestinationArn", async () => {
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: "explicit-dlq" }));
    const dlqArn = await arnOf(dlq.QueueUrl!);
    const source = await sqs.send(new CreateQueueCommand({ QueueName: "explicit-source" }));
    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: source.QueueUrl!,
        Attributes: {
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 1 }),
        },
      }),
    );
    const destination = await sqs.send(new CreateQueueCommand({ QueueName: "explicit-target" }));
    const destinationArn = await arnOf(destination.QueueUrl!);

    // Put messages directly in the DLQ.
    for (let i = 0; i < 3; i++) {
      await sqs.send(new SendMessageCommand({ QueueUrl: dlq.QueueUrl!, MessageBody: `msg-${i}` }));
    }

    const task = await sqs.send(
      new StartMessageMoveTaskCommand({ SourceArn: dlqArn, DestinationArn: destinationArn }),
    );
    expect(task.TaskHandle).toBeDefined();

    // DLQ is now empty.
    const dlqLeft = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq.QueueUrl! }));
    expect(dlqLeft.Messages).toBeUndefined();

    // Destination has all 3 messages.
    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: destination.QueueUrl!, MaxNumberOfMessages: 10 }),
    );
    expect(received.Messages).toHaveLength(3);
  });

  it("ListMessageMoveTasks reports the completed task", async () => {
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: "lmmt-dlq" }));
    const dlqArn = await arnOf(dlq.QueueUrl!);
    const source = await sqs.send(new CreateQueueCommand({ QueueName: "lmmt-source" }));
    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: source.QueueUrl!,
        Attributes: {
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 1 }),
        },
      }),
    );
    await sqs.send(new SendMessageCommand({ QueueUrl: dlq.QueueUrl!, MessageBody: "x" }));
    await sqs.send(new SendMessageCommand({ QueueUrl: dlq.QueueUrl!, MessageBody: "y" }));

    await sqs.send(new StartMessageMoveTaskCommand({ SourceArn: dlqArn }));

    const list = await sqs.send(new ListMessageMoveTasksCommand({ SourceArn: dlqArn }));
    expect(list.Results).toHaveLength(1);
    expect(list.Results![0].Status).toBe("COMPLETED");
    expect(list.Results![0].SourceArn).toBe(dlqArn);
    expect(list.Results![0].ApproximateNumberOfMessagesMoved).toBe(2);
  });

  it("CancelMessageMoveTask rejects an already-completed task", async () => {
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: "cancel-dlq" }));
    const dlqArn = await arnOf(dlq.QueueUrl!);
    const source = await sqs.send(new CreateQueueCommand({ QueueName: "cancel-source" }));
    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: source.QueueUrl!,
        Attributes: {
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 1 }),
        },
      }),
    );

    const task = await sqs.send(new StartMessageMoveTaskCommand({ SourceArn: dlqArn }));

    await expect(
      sqs.send(new CancelMessageMoveTaskCommand({ TaskHandle: task.TaskHandle! })),
    ).rejects.toThrow();
  });

  it("StartMessageMoveTask rejects a source queue that is not a DLQ", async () => {
    const notADlq = await sqs.send(new CreateQueueCommand({ QueueName: "not-a-dlq" }));
    const arn = await arnOf(notADlq.QueueUrl!);

    await expect(
      sqs.send(new StartMessageMoveTaskCommand({ SourceArn: arn })),
    ).rejects.toThrow();
  });

  it("StartMessageMoveTask rejects an unknown source ARN", async () => {
    await expect(
      sqs.send(
        new StartMessageMoveTaskCommand({
          SourceArn: "arn:aws:sqs:us-east-1:000000000000:does-not-exist",
        }),
      ),
    ).rejects.toThrow();
  });
});
