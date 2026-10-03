import { describe, expect, test } from "bun:test";
import type { SyncMonitorRuntimeConfig } from "@anicore/sync-monitor";

import {
  DEFAULT_DRAFT,
  draftFromRuntime,
  draftsEqual,
  isAutoSyncIntervalValid,
  parseRuntimeConfigDraft,
} from "./runtime-config-draft";

const runtime: SyncMonitorRuntimeConfig = {
  version: 1,
  parallel: 3,
  checkpointEvery: 2,
  rateLimitMs: 250,
  startMode: "sync",
  startLimit: null,
  startFromIndex: 10,
  refreshIds: true,
  resetAll: false,
  autoSyncEnabled: true,
  autoSyncIntervalMinutes: 60,
  updatedAt: "2026-01-01T00:00:00.000Z",
  updatedBy: "api",
};

describe("runtime config draft", () => {
  test("round-trips a saved config", () => {
    const draft = draftFromRuntime(runtime);
    expect(draft).toMatchObject({ parallel: "3", startLimit: "", startFromIndex: "10" });

    const parsed = parseRuntimeConfigDraft(draft, 60);
    expect(parsed).toEqual({
      ok: true,
      patch: {
        parallel: 3,
        checkpointEvery: 2,
        rateLimitMs: 250,
        startMode: "sync",
        startLimit: null,
        startFromIndex: 10,
        refreshIds: true,
        resetAll: false,
        autoSyncEnabled: true,
        autoSyncIntervalMinutes: 60,
      },
    });
  });

  test("keeps the saved interval while automatic sync is disabled", () => {
    const draft = { ...DEFAULT_DRAFT, autoSyncEnabled: false, autoSyncIntervalMinutes: "junk" };
    expect(isAutoSyncIntervalValid(draft)).toBe(true);
    const parsed = parseRuntimeConfigDraft(draft, 720);
    expect(parsed.ok && parsed.patch.autoSyncIntervalMinutes).toBe(720);
  });

  test("rejects out-of-range and fractional values with a field-specific message", () => {
    const cases: Array<[Partial<typeof DEFAULT_DRAFT>, string]> = [
      [{ parallel: "0" }, "Parallel fetches"],
      [{ parallel: "1.5" }, "Parallel fetches"],
      [{ checkpointEvery: "10001" }, "Checkpoint every"],
      [{ rateLimitMs: "" }, "Rate limit"],
      [{ startLimit: "-1" }, "Start limit"],
      [{ startFromIndex: "x" }, "Start index"],
      [{ autoSyncIntervalMinutes: "0" }, "Automatic sync interval"],
    ];
    for (const [change, prefix] of cases) {
      const parsed = parseRuntimeConfigDraft({ ...DEFAULT_DRAFT, ...change }, 60);
      expect(parsed.ok).toBe(false);
      expect(!parsed.ok && parsed.error.startsWith(prefix)).toBe(true);
    }
  });

  test("draftsEqual compares every field", () => {
    expect(draftsEqual(DEFAULT_DRAFT, { ...DEFAULT_DRAFT })).toBe(true);
    expect(draftsEqual(DEFAULT_DRAFT, { ...DEFAULT_DRAFT, parallel: "5" })).toBe(false);
    expect(draftsEqual(DEFAULT_DRAFT, { ...DEFAULT_DRAFT, refreshIds: true })).toBe(false);
    expect(draftsEqual(DEFAULT_DRAFT, { ...DEFAULT_DRAFT, startFromIndex: "0" })).toBe(false);
  });
});
