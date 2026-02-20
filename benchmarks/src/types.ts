export interface TaskResult {
  name: string;
  hz: number;
  mean: number;
  p75: number;
  p99: number;
  stdDev: number;
}

export interface BenchmarkResult {
  name: string;
  tasks: TaskResult[];
  totalTimeMs: number;
  timestamp: string;
  nodeVersion: string;
  platform: string;
}
