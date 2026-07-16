import type {
	SyncMonitorAutomationStatus,
	SyncMonitorRuntimeConfig,
	SyncMonitorStatus,
} from "@anicore/sync-monitor";
import { log } from "@anicore/providers/lib/logger";
import {
	appendSyncMonitorEvent,
	readLastSuccessfulSyncAt,
	readSyncMonitorRuntimeConfig,
	readSyncMonitorStatus,
} from "./sync-monitor";
import {
	buildAutomaticSyncArgs,
	isAnySyncActive,
	startSyncProcess,
} from "./sync-process";

const CHECK_INTERVAL_MS = 30_000;
const MINUTE_MS = 60_000;
const FAILURE_RETRY_MINUTES = 15;

interface AutomaticSyncDependencies {
	now?: () => Date;
	readConfig?: () => SyncMonitorRuntimeConfig;
	readStatus?: () => SyncMonitorStatus | null;
	readLastSuccessfulSyncAt?: () => string | null;
	isSyncActive?: () => boolean;
	startSync?: () => number;
	recordEvent?: (
		level: "info" | "error",
		event: string,
		message: string,
	) => void;
	automationAllowed?: () => boolean;
}

const initialState: SyncMonitorAutomationStatus = {
	state: "not-started",
	lastCheckedAt: null,
	lastStartedAt: null,
	nextRunAt: null,
	lastMessage: "Automatic sync scheduler has not started",
};

function validTimestamp(value: string | undefined): number | null {
	if (!value) return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
}

export class AutomaticSyncScheduler {
	private readonly now: () => Date;
	private readonly readConfig: () => SyncMonitorRuntimeConfig;
	private readonly readStatus: () => SyncMonitorStatus | null;
	private readonly readLastSuccessfulSyncAt: () => string | null;
	private readonly isSyncActive: () => boolean;
	private readonly startSync: () => number;
	private readonly recordEvent?: AutomaticSyncDependencies["recordEvent"];
	private readonly automationAllowed: () => boolean;
	private timer: ReturnType<typeof setInterval> | null = null;
	private checking = false;
	private state: SyncMonitorAutomationStatus = { ...initialState };

	constructor(dependencies: AutomaticSyncDependencies = {}) {
		this.now = dependencies.now ?? (() => new Date());
		this.readConfig = dependencies.readConfig ?? readSyncMonitorRuntimeConfig;
		this.readStatus = dependencies.readStatus ?? readSyncMonitorStatus;
		this.readLastSuccessfulSyncAt =
			dependencies.readLastSuccessfulSyncAt ??
			(dependencies.readStatus ? () => null : readLastSuccessfulSyncAt);
		this.isSyncActive = dependencies.isSyncActive ?? isAnySyncActive;
		this.startSync =
			dependencies.startSync ??
			(() => startSyncProcess(buildAutomaticSyncArgs(), "automatic"));
		this.recordEvent = dependencies.recordEvent;
		this.automationAllowed =
			dependencies.automationAllowed ??
			(() => {
				const value = process.env.ANICORE_AUTO_SYNC_ENABLED?.toLowerCase();
				return value !== "0" && value !== "false" && value !== "off";
			});
	}

	start(): void {
		if (this.timer) return;
		this.checkNow();
		this.timer = setInterval(() => this.checkNow(), CHECK_INTERVAL_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	getState(): SyncMonitorAutomationStatus {
		return { ...this.state };
	}

	checkNow(): void {
		if (this.checking) return;
		this.checking = true;
		const now = this.now();
		const checkedAt = now.toISOString();

		try {
			const config = this.readConfig();
			if (!this.automationAllowed()) {
				this.state = {
					...this.state,
					state: "disabled",
					lastCheckedAt: checkedAt,
					nextRunAt: null,
					lastMessage: "Automatic sync is disabled by the environment",
				};
				return;
			}
			if (!config.autoSyncEnabled) {
				this.state = {
					...this.state,
					state: "disabled",
					lastCheckedAt: checkedAt,
					nextRunAt: null,
					lastMessage: "Automatic sync is disabled",
				};
				return;
			}

			if (this.isSyncActive()) {
				this.state = {
					...this.state,
					state: "sync-active",
					lastCheckedAt: checkedAt,
					nextRunAt: null,
					lastMessage: "An existing sync is active; automatic start skipped",
				};
				return;
			}

			const status = this.readStatus();
			const historyAnchor = validTimestamp(this.readLastSuccessfulSyncAt() ?? undefined);
			const statusAnchor =
				status?.mode === "sync"
					? validTimestamp(
							status.completedAt ?? status.updatedAt ?? status.startedAt,
						)
					: null;
			const localAnchor = validTimestamp(this.state.lastStartedAt ?? undefined);
			const intervalMs = config.autoSyncIntervalMinutes * MINUTE_MS;
			const retryMs = Math.min(intervalMs, FAILURE_RETRY_MINUTES * MINUTE_MS);
			const completedStatusAnchor =
				status?.mode === "sync" &&
				(status.state === "completed" || status.state === "stopped")
					? statusAnchor
					: null;
			const successfulAnchor = Math.max(
				historyAnchor ?? 0,
				completedStatusAnchor ?? 0,
			);
			const completedAnchor =
				successfulAnchor > 0 && successfulAnchor >= (localAnchor ?? 0)
					? successfulAnchor
					: null;
			const unsuccessfulAnchor = Math.max(
				completedAnchor === null && status?.mode === "sync"
					? (statusAnchor ?? 0)
					: 0,
				localAnchor ?? 0,
			);
			const dueAt = completedAnchor
				? completedAnchor + intervalMs
				: unsuccessfulAnchor > 0
					? unsuccessfulAnchor + retryMs
					: now.getTime();

			if (dueAt > now.getTime()) {
				this.state = {
					...this.state,
					state: "waiting",
					lastCheckedAt: checkedAt,
					nextRunAt: new Date(dueAt).toISOString(),
					lastMessage: "Automatic sync is waiting for its next interval",
				};
				return;
			}

			const pid = this.startSync();
			const message = `Automatic sync started with PID ${pid}`;
			this.state = {
				state: "waiting",
				lastCheckedAt: checkedAt,
				lastStartedAt: checkedAt,
				nextRunAt: new Date(now.getTime() + retryMs).toISOString(),
				lastMessage: message,
			};
			this.emit("info", "sync.automatic.dispatched", message);
		} catch (error) {
			const message = `Automatic sync check failed: ${error instanceof Error ? error.message : String(error)}`;
			this.state = {
				...this.state,
				state: "error",
				lastCheckedAt: checkedAt,
				nextRunAt: null,
				lastMessage: message,
			};
			this.emit("error", "sync.automatic.failed", message);
		} finally {
			this.checking = false;
		}
	}

	private emit(level: "info" | "error", event: string, message: string): void {
		try {
			this.recordEvent?.(level, event, message);
		} catch {
			// Telemetry is best effort and must never change scheduler control flow.
		}
	}
}

let activeScheduler: AutomaticSyncScheduler | null = null;
const schedulerLog = log.child("automatic-sync");

export function startAutomaticSyncScheduler(): AutomaticSyncScheduler {
	if (activeScheduler) return activeScheduler;
	activeScheduler = new AutomaticSyncScheduler({
		recordEvent: (level, event, message) => {
			schedulerLog[level](JSON.stringify({ event, message }));
			appendSyncMonitorEvent(level, message, {
				event,
				stage: "automatic-sync",
			});
		},
	});
	activeScheduler.start();
	return activeScheduler;
}

export function getAutomaticSyncState(): SyncMonitorAutomationStatus {
	return activeScheduler?.getState() ?? { ...initialState };
}

export function checkAutomaticSyncNow(): void {
	activeScheduler?.checkNow();
}
