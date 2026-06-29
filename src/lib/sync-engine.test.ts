import { describe, expect, test } from "bun:test";

import { SyncEngine } from "./sync-engine";

describe("SyncEngine.iterateParallel", () => {
	test("fetches a batch in parallel before processing it sequentially", async () => {
		const engine = new SyncEngine([]);
		const calls: string[] = [];

		await engine.iterateParallel(
			{
				ids: [1, 2],
				startIndex: 0,
				endIndex: 2,
				label: "test",
				concurrency: 2,
				rateLimitMs: 0,
			},
			async (id) => {
				calls.push(`fetch-start-${id}`);
				if (id === 1) await Bun.sleep(1);
				calls.push(`fetch-end-${id}`);
				return id * 10;
			},
			async (id, _index, _bar, fetched) => {
				calls.push(`process-${id}-${fetched}`);
				return { outcome: "updated" };
			},
		);

		expect(calls.indexOf("process-1-10")).toBeGreaterThan(
			calls.indexOf("fetch-end-1"),
		);
		expect(calls.indexOf("process-1-10")).toBeGreaterThan(
			calls.indexOf("fetch-end-2"),
		);
		expect(calls.indexOf("process-2-20")).toBeGreaterThan(
			calls.indexOf("process-1-10"),
		);
	});

	test("backs off to sequential fetches after reported request failures", async () => {
		const engine = new SyncEngine([]);
		const calls: string[] = [];

		await engine.iterateParallel(
			{
				ids: [1, 2, 3, 4],
				startIndex: 0,
				endIndex: 4,
				label: "test",
				concurrency: 2,
				rateLimitMs: 0,
			},
			async (id, _index, reportIssue) => {
				calls.push(`fetch-start-${id}`);
				if (id === 1) reportIssue("rate-limit");
				return id;
			},
			async (id) => {
				calls.push(`process-${id}`);
				return { outcome: "updated" };
			},
		);

		expect(calls.indexOf("process-3")).toBeGreaterThan(
			calls.indexOf("fetch-start-3"),
		);
		expect(calls.indexOf("fetch-start-4")).toBeGreaterThan(
			calls.indexOf("process-3"),
		);
	});
});
