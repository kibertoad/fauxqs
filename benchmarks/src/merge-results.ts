import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllResults } from './helpers.ts';
import type { BenchmarkResult } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, '..', 'results');

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(1)}ms`;
}

function buildMarkdownTable(results: BenchmarkResult[]): string {
  const lines: string[] = [];

  lines.push('# Benchmark Results\n');
  lines.push(`Generated: ${new Date().toISOString()}\n`);

  if (results.length > 0) {
    lines.push(`Node: ${results[0].nodeVersion} | Platform: ${results[0].platform}\n`);
  }

  lines.push('## Publish 5000 Messages\n');
  lines.push('| Setup | ops/sec | Mean | p75 | p99 | Std Dev |');
  lines.push('|-------|---------|------|-----|-----|---------|');

  for (const r of results) {
    const pub = r.tasks.find((t) => t.name === 'publish 5000');
    if (pub) {
      lines.push(
        `| ${r.name} | ${pub.hz.toFixed(2)} | ${formatMs(pub.mean)} | ${formatMs(pub.p75)} | ${formatMs(pub.p99)} | ${formatMs(pub.stdDev)} |`,
      );
    }
  }

  lines.push('\n## Consume 5000 Messages\n');
  lines.push('| Setup | ops/sec | Mean | p75 | p99 | Std Dev |');
  lines.push('|-------|---------|------|-----|-----|---------|');

  for (const r of results) {
    const con = r.tasks.find((t) => t.name === 'consume 5000');
    if (con) {
      lines.push(
        `| ${r.name} | ${con.hz.toFixed(2)} | ${formatMs(con.mean)} | ${formatMs(con.p75)} | ${formatMs(con.p99)} | ${formatMs(con.stdDev)} |`,
      );
    }
  }

  lines.push('\n## Total Time (setup + warmup + all iterations + teardown)\n');
  lines.push('| Setup | Total |');
  lines.push('|-------|-------|');

  for (const r of results) {
    lines.push(`| ${r.name} | ${r.totalTimeMs ? formatMs(r.totalTimeMs) : 'N/A'} |`);
  }

  return lines.join('\n');
}

const results = readAllResults();

if (results.length === 0) {
  console.log('No results found in results/ directory. Run benchmarks first.');
  process.exit(1);
}

console.log(`Found ${results.length} result(s):\n`);

for (const r of results) {
  console.log(`  - ${r.name} (${r.timestamp})`);
}

const markdown = buildMarkdownTable(results);
console.log('\n' + markdown);

mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(join(RESULTS_DIR, 'RESULTS.md'), markdown);
writeFileSync(join(RESULTS_DIR, '_summary.json'), JSON.stringify(results, null, 2));

console.log('\nWritten: results/RESULTS.md, results/_summary.json');
