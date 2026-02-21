import { SQSClient, CreateQueueCommand } from '@aws-sdk/client-sqs';
import { runBenchmark } from '../benchmark.ts';
import { writeResult, printSummary, pollHealth, dockerComposeUp, dockerComposeDown } from '../helpers.ts';

const PORT = 14568;
const endpoint = `http://127.0.0.1:${PORT}`;
const start = Date.now();

try {
  dockerComposeUp('localstack');
  await pollHealth(`${endpoint}/_localstack/health`, 60_000);
  console.log('localstack is healthy');

  // LocalStack needs us to create the queue and use its returned URL
  const sqs = new SQSClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  const resp = await sqs.send(new CreateQueueCommand({ QueueName: 'bench-queue' }));
  const queueUrl = resp.QueueUrl!;
  sqs.destroy();

  console.log(`LocalStack queue URL: ${queueUrl}`);

  const result = await runBenchmark('localstack', endpoint, queueUrl);
  result.totalTimeMs = Date.now() - start;
  console.log(`\nTotal time: ${(result.totalTimeMs / 1000).toFixed(2)}s`);
  writeResult(result);
  printSummary();
} finally {
  dockerComposeDown('localstack');
}
