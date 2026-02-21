import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkResult } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, '..', 'results');
const COMPOSE_DIR = join(__dirname, '..');

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(1)}ms`;
}

export function writeResult(result: BenchmarkResult): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const filename = `${result.name.replace(/\s+/g, '-').toLowerCase()}.json`;
  writeFileSync(join(RESULTS_DIR, filename), JSON.stringify(result, null, 2));
  console.log(`Result written to results/${filename}`);
}

export function printSummary(): void {
  const results = readAllResults();
  if (results.length <= 1) return;

  console.log(`\n--- All results so far (${results.length} setups) ---\n`);

  const header = ['Setup', 'Publish Mean', 'Consume Mean', 'Total'];
  const rows = results.map((r) => {
    const pub = r.tasks.find((t) => t.name.startsWith('publish'));
    const con = r.tasks.find((t) => t.name.startsWith('consume'));
    return [
      r.name,
      pub ? formatMs(pub.mean) : 'N/A',
      con ? formatMs(con.mean) : 'N/A',
      r.totalTimeMs ? formatMs(r.totalTimeMs) : 'N/A',
    ];
  });

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const pad = (s: string, w: number) => s.padEnd(w);

  console.log(header.map((h, i) => pad(h, widths[i])).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(row.map((c, i) => pad(c, widths[i])).join('  '));
  }
  console.log();
}

export function readAllResults(): BenchmarkResult[] {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const files = readdirSync(RESULTS_DIR).filter(
    (f) => f.endsWith('.json') && f !== '_summary.json',
  );
  return files.map((f) => JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf-8')) as BenchmarkResult);
}

export async function pollHealth(url: string, timeoutMs: number = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await sleep(500);
  }
  throw new Error(`Health check timed out after ${timeoutMs}ms: ${url}`);
}

export function dockerComposeUp(service: string): void {
  execSync(`docker compose -f docker-compose.yml up -d ${service}`, {
    cwd: COMPOSE_DIR,
    stdio: 'inherit',
  });
}

export function dockerComposeDown(service: string): void {
  execSync(`docker compose -f docker-compose.yml down ${service} --volumes --remove-orphans`, {
    cwd: COMPOSE_DIR,
    stdio: 'inherit',
  });
}
