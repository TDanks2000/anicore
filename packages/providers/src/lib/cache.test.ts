import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  appendAnilistId,
  loadIds,
  loadProgress,
  parseProgress,
  saveProgress,
} from "./cache";

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
let tmp: string | null = null;

function useTempCwd(): string {
  tmp = mkdtempSync(join(tmpdir(), "anicore-cache-"));
  process.chdir(tmp);
  return tmp;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
  process.chdir(originalCwd);
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

describe("AniList ID cache", () => {
  test("appends missing ids once and keeps the local file sorted", async () => {
    const dir = useTempCwd();

    expect(appendAnilistId(42)).toBe(true);
    expect(appendAnilistId(7)).toBe(true);
    expect(appendAnilistId(42)).toBe(false);

    expect(readFileSync(join(dir, "data/cache/anilist_ids.txt"), "utf-8")).toBe(
      "7\n42\n",
    );
    expect(await loadIds()).toEqual([7, 42]);
  });

  test("rejects invalid ids", () => {
    useTempCwd();

    expect(() => appendAnilistId(0)).toThrow("Invalid AniList ID: 0");
    expect(() => appendAnilistId(1.5)).toThrow("Invalid AniList ID: 1.5");
  });

	test("preserves ids appended while a refresh request is in flight", async () => {
		useTempCwd();
		appendAnilistId(7);

		let releaseFetch: (() => void) | undefined;
		const waiting = new Promise<void>((resolve) => {
			releaseFetch = resolve;
		});
		globalThis.fetch = Object.assign(
			async () => {
				await waiting;
				return new Response("1\n");
			},
			{ preconnect: () => undefined },
		);

		const refreshing = loadIds(true);
		await Promise.resolve();
		appendAnilistId(42);
		releaseFetch?.();

		expect(await refreshing).toEqual([1, 7, 42]);
	});
});

describe("sync progress checkpoint", () => {
  const validProgress = {
    version: 1,
    lastIndex: 123,
    stats: { created: 10, updated: 100, failed: 2 },
  };

  test("accepts only complete non-negative integer progress", () => {
    expect(parseProgress(validProgress)).toEqual(validProgress);

    const invalid = [
      null,
      [],
      { ...validProgress, version: 2 },
      { ...validProgress, lastIndex: -1 },
      { ...validProgress, lastIndex: 1.5 },
      { ...validProgress, lastIndex: "123" },
      { ...validProgress, stats: { created: 1, updated: 2 } },
      { ...validProgress, stats: { created: -1, updated: 2, failed: 0 } },
      { ...validProgress, stats: { created: 1, updated: 2.5, failed: 0 } },
      { ...validProgress, stats: "invalid" },
    ];

    for (const value of invalid) {
      expect(parseProgress(value)).toBeNull();
    }
  });

  test("returns a fresh default when no checkpoint exists", async () => {
    useTempCwd();

    const first = await loadProgress();
    first.stats.created = 99;
    const second = await loadProgress();

    expect(second).toEqual({
      version: 1,
      lastIndex: 0,
      stats: { created: 0, updated: 0, failed: 0 },
    });
  });

  test("refuses unreadable or structurally invalid checkpoints instead of restarting from zero", async () => {
    const dir = useTempCwd();
    const cacheDir = join(dir, "data/cache");
    const progressPath = join(cacheDir, "progress.json");
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(progressPath, "{not-json");
    await expect(loadProgress()).rejects.toThrow(
      "Refusing to restart from index 0",
    );

    writeFileSync(
      progressPath,
      JSON.stringify({ version: 1, lastIndex: -5, stats: validProgress.stats }),
    );
    await expect(loadProgress()).rejects.toThrow(
      "invalid shape or unsupported version",
    );
  });

  test("atomically replaces a valid checkpoint", async () => {
    const dir = useTempCwd();
    await saveProgress(validProgress);

    expect(await loadProgress()).toEqual(validProgress);
    expect(
      JSON.parse(
        readFileSync(join(dir, "data/cache/progress.json"), "utf-8"),
      ),
    ).toEqual(validProgress);
  });

  test("rejects an invalid save without damaging the previous checkpoint", async () => {
    const dir = useTempCwd();
    await saveProgress(validProgress);
    const progressPath = join(dir, "data/cache/progress.json");
    const before = readFileSync(progressPath, "utf-8");

    await expect(
      saveProgress({
        version: 1,
        lastIndex: -1,
        stats: { created: 0, updated: 0, failed: 0 },
      }),
    ).rejects.toThrow("Refusing to write an invalid sync checkpoint");

    expect(readFileSync(progressPath, "utf-8")).toBe(before);
    expect(await loadProgress()).toEqual(validProgress);
  });
});
