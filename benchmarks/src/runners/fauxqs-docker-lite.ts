import { runBenchmark } from '../benchmark.ts';
import { writeResult, printSummary, pollHealth, dockerComposeUp, dockerComposeDown } from '../helpers.ts';

const PORT = 14567;
const endpoint = `http://127.0.0.1:${PORT}`;
const start = Date.now();

try {
  dockerComposeUp('fauxqs-docker-lite');
  await pollHealth(`${endpoint}/_fauxqs/queues`, 120_000);
  console.log('fauxqs-docker-lite is healthy');

  const result = await runBenchmark('fauxqs-docker-lite', endpoint);
  result.totalTimeMs = Date.now() - start;
  console.log(`\nTotal time: ${(result.totalTimeMs / 1000).toFixed(2)}s`);
  writeResult(result);
  printSummary();
} finally {
  dockerComposeDown('fauxqs-docker-lite');
}
