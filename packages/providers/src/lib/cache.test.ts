import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { appendAnilistId, loadIds } from "./cache";

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
