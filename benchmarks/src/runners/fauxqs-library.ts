import { startFauxqs } from 'fauxqs';
import { runBenchmark } from '../benchmark.ts';
import { writeResult, printSummary } from '../helpers.ts';

const start = Date.now();
const server = await startFauxqs({ port: 0, logger: false });

try {
  const result = await runBenchmark('fauxqs-library', `http://127.0.0.1:${server.port}`);
  result.totalTimeMs = Date.now() - start;
  console.log(`\nTotal time: ${(result.totalTimeMs / 1000).toFixed(2)}s`);
  writeResult(result);
  printSummary();
} finally {
  await server.stop();
}
