import { describe, expect, test } from "bun:test";

import type {
	SyncMonitorRuntimeConfig,
	SyncMonitorStatus,
} from "@anicore/sync-monitor";
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

function stoppedStatus(completedAt: string): SyncMonitorStatus {
	return {
		version: 1,
		runId: "stopped-run",
		state: "stopped",
		mode: "sync",
		pid: 123,
		startedAt: "2026-07-16T11:00:00.000Z",
		updatedAt: completedAt,
		completedAt,
		total: 10,
		startIndex: 0,
		endIndex: 10,
		currentIndex: 4,
		currentAnilistId: 5,
		currentStage: "stopped",
		parallel: 4,
		providers: ["anilist"],
		progress: {
			processed: 5,
			remaining: 5,
			percent: 50,
			elapsedMs: 60_000,
			ratePerMinute: 5,
			etaSeconds: 60,
		},
		activeBatch: null,
		runtimeConfig: runtimeConfig(),
		stats: { created: 0, updated: 5, failed: 0 },
		lastError: null,
		recentErrors: [],
	};
}

describe("AutomaticSyncScheduler stopped runs", () => {
	test("retries a stopped sync on the failure retry interval", () => {
		let starts = 0;
		let now = new Date("2026-07-16T12:00:00.000Z");
		const scheduler = new AutomaticSyncScheduler({
			now: () => now,
			readConfig: runtimeConfig,
			readStatus: () => stoppedStatus("2026-07-16T11:50:00.000Z"),
			isSyncActive: () => false,
			startSync: () => {
				starts++;
				return 999;
			},
		});

		scheduler.checkNow();
		expect(starts).toBe(0);
		expect(scheduler.getState().nextRunAt).toBe(
			"2026-07-16T12:05:00.000Z",
		);

		now = new Date("2026-07-16T12:05:00.000Z");
		scheduler.checkNow();
		expect(starts).toBe(1);
	});
});
