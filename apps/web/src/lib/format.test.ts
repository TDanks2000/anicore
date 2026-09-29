import { describe, expect, test } from "bun:test";
import type { SyncMonitorStatus } from "@anicore/sync-monitor";

import { completionPercent, formatDuration, formatEta, formatMs, formatRate } from "./format";

describe("format", () => {
  test("formats durations at each scale", () => {
    expect(formatMs(undefined)).toBe("Not available");
    expect(formatMs(4_400)).toBe("4s");
    expect(formatMs(125_000)).toBe("2m 5s");
    expect(formatMs(3_780_000)).toBe("1h 3m");
    expect(formatMs(-5)).toBe("0s");
  });

  test("measures elapsed time up to now when a run has not finished", () => {
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-01T00:01:30Z")).toBe("1m 30s");
    expect(
      formatDuration("2026-01-01T00:00:00Z", undefined, Date.parse("2026-01-01T00:00:10Z")),
    ).toBe("10s");
    expect(formatDuration(undefined)).toBe("Not available");
  });

  test("formats ETA and rate", () => {
    expect(formatEta(null)).toBe("Calculating");
    expect(formatEta(90)).toBe("1m 30s");
    expect(formatRate(undefined)).toBe("Unknown");
    expect(formatRate(4.25)).toBe("4.3/min");
    expect(formatRate(42.4)).toBe("42/min");
  });

  test("derives completion when the status has no progress block", () => {
    const status = { total: 10, startIndex: 5, currentIndex: 9 } as SyncMonitorStatus;
    expect(completionPercent(null)).toBe(0);
    expect(completionPercent(status)).toBe(50);
    expect(completionPercent({ ...status, progress: { percent: 73 } } as SyncMonitorStatus)).toBe(
      73,
    );
  });
});
