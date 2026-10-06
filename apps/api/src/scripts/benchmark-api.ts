interface BenchmarkOptions {
  baseUrl: string;
  requests: number;
  concurrency: number;
  warmup: number;
  paths: string[];
}

export function benchmarkOptions(args: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {
    baseUrl: "http://localhost:3000",
    requests: 100,
    concurrency: 4,
    warmup: 5,
    paths: [],
  };
  for (const arg of args) {
    const separator = arg.indexOf("=");
    const key = arg.slice(0, separator);
    const value = arg.slice(separator + 1);
    if (separator < 0) throw new Error(`Expected --option=value: ${arg}`);
    if (key === "--base-url") options.baseUrl = value;
    else if (key === "--path") options.paths.push(value);
    else if (key === "--requests" || key === "--concurrency" || key === "--warmup") {
      const number = Number(value);
      const maximum = key === "--concurrency" ? 64 : 100_000;
      const minimum = key === "--warmup" ? 0 : 1;
      if (!Number.isInteger(number) || number < minimum || number > maximum) {
        throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
      }
      if (key === "--requests") options.requests = number;
      else if (key === "--concurrency") options.concurrency = number;
      else options.warmup = number;
    } else throw new Error(`Unknown option: ${key}`);
  }
  const base = new URL(options.baseUrl);
  if (
    !/^https?:$/.test(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error("--base-url must be an HTTP(S) URL without credentials, query or fragment");
  }
  if (!options.paths.length)
    options.paths = [
      "/anime?limit=50&offset=0",
      "/anime?limit=50&q=naruto",
      "/anime?limit=50&format=TV&sort=score&order=desc",
      "/anime?limit=50&offset=10000",
    ];
  for (const path of options.paths) {
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      new URL(path, base).origin !== base.origin
    ) {
      throw new Error("--path must be an absolute path on the selected API origin");
    }
  }
  return options;
}

export async function benchmarkApi(options: BenchmarkOptions) {
  const reports = [];
  for (const path of options.paths) {
    const url = new URL(path, options.baseUrl);
    for (let i = 0; i < options.warmup; i++) {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      await response.arrayBuffer();
      if (!response.ok) throw new Error(`Warmup failed with HTTP ${response.status}`);
    }
    const durations: number[] = [];
    const statuses: Record<string, number> = {};
    let next = 0;
    let failures = 0;
    let bytes = 0;
    const started = performance.now();
    await Promise.all(
      Array.from({ length: Math.min(options.concurrency, options.requests) }, async () => {
        while (next < options.requests) {
          next++;
          const requestStarted = performance.now();
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
            bytes += (await response.arrayBuffer()).byteLength;
            statuses[response.status] = (statuses[response.status] ?? 0) + 1;
            if (response.ok) durations.push(performance.now() - requestStarted);
            else failures++;
          } catch {
            failures++;
            statuses.network_error = (statuses.network_error ?? 0) + 1;
          }
        }
      }),
    );
    const elapsedMs = performance.now() - started;
    durations.sort((a, b) => a - b);
    const percentile = (fraction: number) =>
      durations.length
        ? Math.round(durations[Math.ceil(durations.length * fraction) - 1]! * 100) / 100
        : null;
    reports.push({
      path,
      requests: options.requests,
      concurrency: options.concurrency,
      successes: durations.length,
      failures,
      statuses,
      bytes,
      elapsedMs: Math.round(elapsedMs),
      successfulRequestsPerSecond: Math.round(((durations.length * 1000) / elapsedMs) * 100) / 100,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
    });
  }
  return reports;
}

if (import.meta.main) {
  try {
    const reports = await benchmarkApi(benchmarkOptions(process.argv.slice(2)));
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));
    if (reports.some((report) => report.failures > 0)) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
