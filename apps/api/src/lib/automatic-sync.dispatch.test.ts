import { describe, expect, test } from "bun:test";

import type { SyncMonitorRuntimeConfig } from "@anicore/sync-monitor";
import { AutomaticSyncScheduler } from "./automatic-sync";

function runtimeConfig(): SyncMonitorRuntimeConfig {
	return {
		version: 1,
		parallel: 4,
		checkpointEvery: 10,
		rateLimitMs: 1500,
		startMode: "sync",
		startLimit: null,
		startFromIndex: 0,
		refreshIds: true,
		resetAll: false,
		autoSyncEnabled: true,
		autoSyncIntervalMinutes: 1440,
		updatedAt: "2026-07-16T00:00:00.000Z",
		updatedBy: "default",
	};
}

describe("AutomaticSyncScheduler failed dispatches", () => {
	test("backs off after process creation throws instead of retrying every poll", () => {
		let starts = 0;
		let now = new Date("2026-07-16T12:00:00.000Z");
		const scheduler = new AutomaticSyncScheduler({
			now: () => now,
			readConfig: runtimeConfig,
			readStatus: () => null,
			isSyncActive: () => false,
			startSync: () => {
				starts++;
				throw new Error("spawn failed");
			},
		});

		scheduler.checkNow();
		expect(starts).toBe(1);
		expect(scheduler.getState()).toMatchObject({
			state: "error",
			lastStartedAt: null,
			nextRunAt: "2026-07-16T12:15:00.000Z",
			lastMessage: "Automatic sync check failed: spawn failed",
		});

		now = new Date("2026-07-16T12:00:30.000Z");
		scheduler.checkNow();
		expect(starts).toBe(1);
		expect(scheduler.getState()).toMatchObject({
			state: "waiting",
			nextRunAt: "2026-07-16T12:15:00.000Z",
		});

		now = new Date("2026-07-16T12:15:00.000Z");
		scheduler.checkNow();
		expect(starts).toBe(2);
		expect(scheduler.getState().nextRunAt).toBe(
			"2026-07-16T12:30:00.000Z",
		);
	});
});
