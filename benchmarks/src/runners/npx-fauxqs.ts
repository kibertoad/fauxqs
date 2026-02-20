import { runBenchmark } from '../benchmark.js';
import { writeResult, printSummary, pollHealth, dockerComposeUp, dockerComposeDown } from '../helpers.js';

const PORT = 14567;
const endpoint = `http://127.0.0.1:${PORT}`;
const start = Date.now();

try {
  dockerComposeUp('fauxqs-npx');
  await pollHealth(`${endpoint}/_fauxqs/queues`, 120_000);
  console.log('fauxqs-npx is healthy');

  const result = await runBenchmark('npx-fauxqs', endpoint);
  result.totalTimeMs = Date.now() - start;
  console.log(`\nTotal time: ${(result.totalTimeMs / 1000).toFixed(2)}s`);
  writeResult(result);
  printSummary();
} finally {
  dockerComposeDown('fauxqs-npx');
}
