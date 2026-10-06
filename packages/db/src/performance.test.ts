import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { flushPerformanceMetrics, recordDuration } from "./performance";

let previous: string | undefined;
const info = spyOn(console, "info");
beforeEach(() => {
  previous = process.env.ANICORE_PERFORMANCE;
  delete process.env.ANICORE_PERFORMANCE;
  flushPerformanceMetrics();
  info.mockReset();
  info.mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.ANICORE_PERFORMANCE;
  flushPerformanceMetrics();
  if (previous !== undefined) process.env.ANICORE_PERFORMANCE = previous;
});
afterAll(() => info.mockRestore());

describe("performance summaries", () => {
  test("disabled measurements do not log or survive into an enabled interval", () => {
    recordDuration("disabled", 100);
    flushPerformanceMetrics();
    expect(info).not.toHaveBeenCalled();
    process.env.ANICORE_PERFORMANCE = "1";
    recordDuration("db.lock_wait", 2);
    recordDuration("db.lock_wait", 4);
    recordDuration("invalid", Number.NaN);
    flushPerformanceMetrics();
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0]![0]))).toMatchObject({
      event: "performance.summary",
      measurements: {
        "db.lock_wait": { count: 2, sampleCount: 2, meanMs: 3, maxMs: 4, p50Ms: 2, p95Ms: 4 },
      },
    });
    expect(String(info.mock.calls[0]![0])).not.toContain("disabled");
    flushPerformanceMetrics();
    expect(info).toHaveBeenCalledTimes(1);
  });

  test("bounds retained samples and metric names while counting the complete interval", () => {
    process.env.ANICORE_PERFORMANCE = "1";
    for (let i = 0; i < 1000; i++) recordDuration("query", i);
    for (let i = 0; i < 1000; i++) recordDuration(`name${i}`, 1);
    flushPerformanceMetrics();
    const summary = JSON.parse(String(info.mock.calls[0]![0]));
    expect(Object.keys(summary.measurements)).toHaveLength(64);
    expect(summary.measurements.query).toMatchObject({
      count: 1000,
      sampleCount: 512,
      meanMs: 499.5,
      maxMs: 999,
    });
  });
});
