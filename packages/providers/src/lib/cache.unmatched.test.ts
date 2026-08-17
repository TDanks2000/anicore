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
	appendUnmatched,
	loadUnmatched,
	UNMATCHED_CACHE_TTL_MS,
} from "./cache";

const originalCwd = process.cwd();
let tmp: string | null = null;

function useTempCwd(): string {
	tmp = mkdtempSync(join(tmpdir(), "anicore-unmatched-cache-"));
	process.chdir(tmp);
	return tmp;
}

afterEach(() => {
	process.chdir(originalCwd);
	if (tmp) {
		rmSync(tmp, { recursive: true, force: true });
		tmp = null;
	}
});

describe("provider unmatched cache", () => {
	test("keeps fresh unmatched IDs and expires them after the TTL", () => {
		const dir = useTempCwd();
		const now = 1_800_000_000_000;

		appendUnmatched("kitsu", 42, now);

		expect(loadUnmatched("kitsu", now)).toEqual(new Set([42]));
		expect(
			loadUnmatched("kitsu", now + UNMATCHED_CACHE_TTL_MS + 1),
		).toEqual(new Set());
		expect(
			readFileSync(join(dir, "data/cache/kitsu_unmatched.txt"), "utf-8"),
		).toBe("");
	});

	test("expires legacy bare-ID cache entries so they are retried after upgrade", () => {
		const dir = useTempCwd();
		const cacheDir = join(dir, "data/cache");
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(join(cacheDir, "kitsu_unmatched.txt"), "42\n99\n");

		expect(loadUnmatched("kitsu", 1_800_000_000_000)).toEqual(new Set());
		expect(
			readFileSync(join(cacheDir, "kitsu_unmatched.txt"), "utf-8"),
		).toBe("");
	});

	test("keeps only the freshest timestamp for duplicate IDs", () => {
		const dir = useTempCwd();
		const now = 1_800_000_000_000;
		const staleAt = now - UNMATCHED_CACHE_TTL_MS - 1;
		const freshAt = now - 1_000;

		appendUnmatched("kitsu", 42, staleAt);
		appendUnmatched("kitsu", 42, freshAt);

		expect(loadUnmatched("kitsu", now)).toEqual(new Set([42]));
		expect(
			readFileSync(join(dir, "data/cache/kitsu_unmatched.txt"), "utf-8"),
		).toBe(`42\t${freshAt}\n`);
	});
});
