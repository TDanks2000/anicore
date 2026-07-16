import { describe, expect, test } from "bun:test";

import type {
	SyncMonitorRuntimeConfig,
	SyncMonitorStatus,
} from "@anicore/sync-monitor";
import { AutomaticSyncScheduler } from "./automatic-sync";
import { SyncMonitor } from "./sync-monitor";

function runtimeConfig(
	overrides: Partial<SyncMonitorRuntimeConfig> = {},
): SyncMonitorRuntimeConfig {
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
		...overrides,
	};
}

function completedStatus(completedAt: string): SyncMonitorStatus {
	return {
		version: 1,
		runId: "test-run",
		state: "completed",
		mode: "sync",
		pid: 123,
		startedAt: completedAt,
		updatedAt: completedAt,
		completedAt,
		total: 1,
		startIndex: 0,
		endIndex: 1,
		currentIndex: 0,
		currentAnilistId: 1,
		currentStage: "complete",
		parallel: 4,
		providers: ["anilist"],
		progress: {
			processed: 1,
			remaining: 0,
			percent: 100,
			elapsedMs: 1000,
			ratePerMinute: 60,
			etaSeconds: 0,
		},
		activeBatch: null,
		runtimeConfig: runtimeConfig(),
		stats: { created: 0, updated: 1, failed: 0 },
		lastError: null,
		recentErrors: [],
	};
}

function completedDryRunStatus(completedAt: string): SyncMonitorStatus {
	return { ...completedStatus(completedAt), mode: "dry-run" };
}

describe("AutomaticSyncScheduler", () => {
	test("starts a configured sync immediately when no previous run exists", () => {
		let starts = 0;
		const scheduler = new AutomaticSyncScheduler({
			now: () => new Date("2026-07-16T12:00:00.000Z"),
			readConfig: () => runtimeConfig(),
			readStatus: () => null,
			isSyncActive: () => false,
			startSync: () => {
				starts++;
				return 987;
			},
		});

		scheduler.checkNow();

		expect(starts).toBe(1);
		expect(scheduler.getState()).toMatchObject({
			state: "waiting",
			lastStartedAt: "2026-07-16T12:00:00.000Z",
			nextRunAt: "2026-07-16T12:15:00.000Z",
			lastMessage: "Automatic sync started with PID 987",
		});
	});

	test("retries a failed sync on the bounded failure interval", () => {
		let starts = 0;
		let now = new Date("2026-07-16T12:00:00.000Z");
		const failedStatus = {
			...completedStatus("2026-07-16T11:50:00.000Z"),
			state: "failed" as const,
		};
		const scheduler = new AutomaticSyncScheduler({
			now: () => now,
			readConfig: () => runtimeConfig(),
			readStatus: () => failedStatus,
			isSyncActive: () => false,
			startSync: () => {
				starts++;
				return 333;
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

	test("waits until the persisted completion is due", () => {
		let starts = 0;
		let now = new Date("2026-07-16T12:00:00.000Z");
		const scheduler = new AutomaticSyncScheduler({
			now: () => now,
			readConfig: () => runtimeConfig({ autoSyncIntervalMinutes: 60 }),
			readStatus: () => completedStatus("2026-07-16T11:30:00.000Z"),
			isSyncActive: () => false,
			startSync: () => {
				starts++;
				return 654;
			},
		});

		scheduler.checkNow();
		expect(starts).toBe(0);
		expect(scheduler.getState()).toMatchObject({
			state: "waiting",
			nextRunAt: "2026-07-16T12:30:00.000Z",
		});

		now = new Date("2026-07-16T12:30:00.000Z");
		scheduler.checkNow();
		expect(starts).toBe(1);
	});

	test("does not restart repeatedly while an old completion remains on disk", () => {
		let starts = 0;
		let now = new Date("2026-07-16T12:00:00.000Z");
		const scheduler = new AutomaticSyncScheduler({
			now: () => now,
			readConfig: () => runtimeConfig({ autoSyncIntervalMinutes: 60 }),
			readStatus: () => completedStatus("2026-07-16T10:00:00.000Z"),
			isSyncActive: () => false,
			startSync: () => {
				starts++;
				return 555;
			},
		});

		scheduler.checkNow();
		expect(starts).toBe(1);

		now = new Date("2026-07-16T12:00:30.000Z");
		scheduler.checkNow();
		expect(starts).toBe(1);
		expect(scheduler.getState().nextRunAt).toBe(
			"2026-07-16T12:15:00.000Z",
		);
	});

	test("never overlaps an active manual or automatic sync", () => {
		let starts = 0;
		const scheduler = new AutomaticSyncScheduler({
			now: () => new Date("2026-07-16T12:00:00.000Z"),
			readConfig: () => runtimeConfig(),
			readStatus: () => null,
			isSyncActive: () => true,
			startSync: () => {
				starts++;
				return 321;
			},
		});

		scheduler.checkNow();

		expect(starts).toBe(0);
		expect(scheduler.getState()).toMatchObject({
			state: "sync-active",
			lastMessage: "An existing sync is active; automatic start skipped",
		});
	});

	test("does not let a dry run delay the next real automatic sync", () => {
		let starts = 0;
		const scheduler = new AutomaticSyncScheduler({
			now: () => new Date("2026-07-16T12:00:00.000Z"),
			readConfig: () => runtimeConfig(),
			readStatus: () => completedDryRunStatus("2026-07-16T11:59:00.000Z"),
			isSyncActive: () => false,
			startSync: () => {
				starts++;
				return 222;
			},
		});

		scheduler.checkNow();

		expect(starts).toBe(1);
	});

	test("keeps real-sync cadence after a newer dry run overwrites status", () => {
		let starts = 0;
		const scheduler = new AutomaticSyncScheduler({
			now: () => new Date("2026-07-16T12:00:00.000Z"),
			readConfig: () => runtimeConfig({ autoSyncIntervalMinutes: 60 }),
			readStatus: () => completedDryRunStatus("2026-07-16T11:55:00.000Z"),
			readLastSuccessfulSyncAt: () => "2026-07-16T11:30:00.000Z",
			isSyncActive: () => false,
			startSync: () => {
				starts++;
				return 777;
			},
		});

		scheduler.checkNow();

		expect(starts).toBe(0);
		expect(scheduler.getState().nextRunAt).toBe(
			"2026-07-16T12:30:00.000Z",
		);
	});

	test("stays disabled until automation is enabled", () => {
		let starts = 0;
		const scheduler = new AutomaticSyncScheduler({
			now: () => new Date("2026-07-16T12:00:00.000Z"),
			readConfig: () => runtimeConfig({ autoSyncEnabled: false }),
			readStatus: () => null,
			isSyncActive: () => false,
			startSync: () => {
				starts++;
				return 1;
			},
		});

		scheduler.checkNow();

		expect(starts).toBe(0);
		expect(scheduler.getState()).toMatchObject({
			state: "disabled",
			nextRunAt: null,
		});
	});

	test("honors the environment kill switch", () => {
		let starts = 0;
		const scheduler = new AutomaticSyncScheduler({
			now: () => new Date("2026-07-16T12:00:00.000Z"),
			readConfig: () => runtimeConfig(),
			readStatus: () => null,
			isSyncActive: () => false,
			automationAllowed: () => false,
			startSync: () => {
				starts++;
				return 1;
			},
		});

		scheduler.checkNow();

		expect(starts).toBe(0);
		expect(scheduler.getState()).toMatchObject({
			state: "disabled",
			lastMessage: "Automatic sync is disabled by the environment",
		});
	});

	test("keeps telemetry failures out of scheduler control flow", () => {
		const scheduler = new AutomaticSyncScheduler({
			now: () => new Date("2026-07-16T12:00:00.000Z"),
			readConfig: () => runtimeConfig(),
			readStatus: () => null,
			isSyncActive: () => false,
			startSync: () => 444,
			recordEvent: () => {
				throw new Error("read-only event directory");
			},
		});

		expect(() => scheduler.checkNow()).not.toThrow();
		expect(scheduler.getState()).toMatchObject({
			state: "waiting",
			lastMessage: "Automatic sync started with PID 444",
		});
	});
});

describe("SyncMonitor liveness", () => {
	test("does not trust a silent running status even when its PID was reused", () => {
		const staleAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
		const status = {
			...completedStatus(staleAt),
			state: "running" as const,
			pid: process.pid,
			updatedAt: staleAt,
		};

		expect(SyncMonitor.isLikelyActive(status)).toBe(false);
	});
});
