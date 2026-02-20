import { Bench } from 'tinybench';
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageBatchCommand,
  ReceiveMessageCommand,
  DeleteMessageBatchCommand,
  PurgeQueueCommand,
} from '@aws-sdk/client-sqs';
import type { BenchmarkResult, TaskResult } from './types.js';
import { sleep } from './helpers.js';

const MESSAGE_COUNT = 5000;
const BATCH_SIZE = 10;

function createSqsClient(endpoint: string): SQSClient {
  return new SQSClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

async function publishMessages(sqs: SQSClient, queueUrl: string, count: number): Promise<void> {
  const batches = Math.ceil(count / BATCH_SIZE);
  for (let i = 0; i < batches; i++) {
    const entries = [];
    for (let j = 0; j < BATCH_SIZE && i * BATCH_SIZE + j < count; j++) {
      entries.push({
        Id: String(j),
        MessageBody: JSON.stringify({ index: i * BATCH_SIZE + j, ts: Date.now() }),
      });
    }
    await sqs.send(new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: entries }));
  }
}

async function consumeMessages(sqs: SQSClient, queueUrl: string, count: number): Promise<void> {
  let consumed = 0;
  while (consumed < count) {
    const resp = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 5,
      }),
    );
    const messages = resp.Messages ?? [];
    if (messages.length === 0) continue;

    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: messages.map((m, i) => ({
          Id: String(i),
          ReceiptHandle: m.ReceiptHandle!,
        })),
      }),
    );
    consumed += messages.length;
  }
}

export async function runBenchmark(
  name: string,
  endpoint: string,
  queueUrl?: string,
): Promise<BenchmarkResult> {
  console.log(`\n=== ${name} ===\n`);

  const sqs = createSqsClient(endpoint);

  if (!queueUrl) {
    const resp = await sqs.send(
      new CreateQueueCommand({ QueueName: 'bench-queue' }),
    );
    queueUrl = resp.QueueUrl!;
  }

  console.log(`Queue URL: ${queueUrl}`);

  const bench = new Bench({ iterations: 5, warmupIterations: 1 });

  bench.add(`publish ${MESSAGE_COUNT}`, async () => {
    await publishMessages(sqs, queueUrl!, MESSAGE_COUNT);
  }, {
    afterEach: async () => {
      await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl! }));
      await sleep(100);
    },
  });

  bench.add(`consume ${MESSAGE_COUNT}`, async () => {
    await consumeMessages(sqs, queueUrl!, MESSAGE_COUNT);
  }, {
    beforeEach: async () => {
      await publishMessages(sqs, queueUrl!, MESSAGE_COUNT);
    },
    afterEach: async () => {
      await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl! }));
      await sleep(100);
    },
  });

  await bench.run();

  console.table(bench.table());

  const tasks: TaskResult[] = bench.tasks.map((task) => ({
    name: task.name,
    hz: task.result!.hz,
    mean: task.result!.mean,
    p75: task.result!.p75,
    p99: task.result!.p99,
    stdDev: task.result!.sd,
  }));

  sqs.destroy();

  return {
    name,
    tasks,
    totalTimeMs: 0,
    timestamp: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
  };
}
