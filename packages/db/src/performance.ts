/** Opt-in, bounded measurements. Never record SQL, parameters, URLs or credentials. */
const MAX_SAMPLES = 512;
const MAX_METRICS = 64;
const metrics = new Map<
  string,
  { count: number; totalMs: number; maxMs: number; samples: number[] }
>();
let timer: ReturnType<typeof setInterval> | undefined;

export function performanceEnabled(): boolean {
  return process.env.ANICORE_PERFORMANCE === "1";
}

export function recordDuration(name: string, durationMs: number): void {
  if (!performanceEnabled() || !Number.isFinite(durationMs) || durationMs < 0) return;
  let metric = metrics.get(name);
  if (!metric) {
    if (metrics.size >= MAX_METRICS) return;
    metric = { count: 0, totalMs: 0, maxMs: 0, samples: [] };
    metrics.set(name, metric);
  }
  metric.samples[metric.count % MAX_SAMPLES] = durationMs;
  metric.count++;
  metric.totalMs += durationMs;
  metric.maxMs = Math.max(metric.maxMs, durationMs);
  if (!timer) {
    timer = setInterval(flushPerformanceMetrics, 30_000);
    timer.unref();
  }
}

export function flushPerformanceMetrics(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  if (!metrics.size) return;
  const round = (value: number) => Math.round(value * 100) / 100;
  const measurements = Object.fromEntries(
    [...metrics].map(([name, metric]) => {
      const sorted = metric.samples.sort((a, b) => a - b);
      const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
      return [
        name,
        {
          count: metric.count,
          sampleCount: sorted.length,
          meanMs: round(metric.totalMs / metric.count),
          maxMs: round(metric.maxMs),
          p50Ms: round(percentile(0.5)),
          p95Ms: round(percentile(0.95)),
          p99Ms: round(percentile(0.99)),
        },
      ];
    }),
  );
  metrics.clear();
  if (!performanceEnabled()) return;
  console.info(
    JSON.stringify({
      event: "performance.summary",
      pid: process.pid,
      rssBytes: process.memoryUsage().rss,
      measurements,
    }),
  );
}
