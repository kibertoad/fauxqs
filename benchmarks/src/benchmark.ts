import { Bench } from 'tinybench';
import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  PurgeQueueCommand,
} from '@aws-sdk/client-sqs';
import type { BenchmarkResult, TaskResult } from './types.ts';
import { sleep } from './helpers.ts';

const MESSAGE_COUNT = 5000;

function createSqsClient(endpoint: string): SQSClient {
  return new SQSClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

async function publishMessages(sqs: SQSClient, queueUrl: string, count: number, label: string): Promise<void> {
  for (let i = 0; i < count; i++) {
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ index: i, ts: Date.now() }),
    }));
    if ((i + 1) % 500 === 0) console.log(`  ${label} published ${i + 1}/${count}`);
  }
}

async function consumeMessages(sqs: SQSClient, queueUrl: string, count: number, label: string): Promise<void> {
  let consumed = 0;
  while (consumed < count) {
    const resp = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 5,
      }),
    );
    const message = resp.Messages?.[0];
    if (!message) continue;

    await sqs.send(new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: message.ReceiptHandle!,
    }));
    consumed++;
    if (consumed % 500 === 0) console.log(`  ${label} consumed ${consumed}/${count}`);
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

  const WARMUP = 1;
  const ITERATIONS = 5;
  const bench = new Bench({ iterations: ITERATIONS, warmupIterations: WARMUP });

  let publishRun = 0;
  bench.add(`publish ${MESSAGE_COUNT}`, async () => {
    publishRun++;
    const label = publishRun <= WARMUP ? '[warmup]' : `[${publishRun - WARMUP}/${ITERATIONS}]`;
    await publishMessages(sqs, queueUrl!, MESSAGE_COUNT, label);
  }, {
    afterEach: async () => {
      await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl! }));
      await sleep(100);
    },
  });

  let consumeRun = 0;
  bench.add(`consume ${MESSAGE_COUNT}`, async () => {
    consumeRun++;
    const label = consumeRun <= WARMUP ? '[warmup]' : `[${consumeRun - WARMUP}/${ITERATIONS}]`;
    await consumeMessages(sqs, queueUrl!, MESSAGE_COUNT, label);
  }, {
    beforeEach: async () => {
      await publishMessages(sqs, queueUrl!, MESSAGE_COUNT, '(setup)');
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
