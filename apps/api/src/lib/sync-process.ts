import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "@anicore/providers/lib/logger";

import {
	appendSyncMonitorEvent,
	ensureSyncMonitorAccessCode,
	getSyncMonitorPublicConfig,
	readSyncMonitorRuntimeConfig,
	readSyncMonitorStatus,
	SyncMonitor,
	writeSyncMonitorControlState,
} from "./sync-monitor";
import type { SyncMonitorStartOptions } from "@anicore/sync-monitor";

export type SyncStartSource = "api" | "automatic";

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const syncScriptPath = resolve(apiRoot, "src/scripts/sync.ts");

let activeSyncChild: ReturnType<typeof Bun.spawn> | null = null;
const processLog = log.child("sync-process");

export function buildSyncStartArgs(
	options: SyncMonitorStartOptions = {},
): string[] {
	const runtime = readSyncMonitorRuntimeConfig();
	const dryRun = options.dryRun ?? runtime.startMode === "dry-run";
	const limit = options.limit ?? runtime.startLimit ?? undefined;
	const fromIndex = options.fromIndex ?? runtime.startFromIndex ?? undefined;
	const refreshIds = options.refreshIds ?? runtime.refreshIds;
	const resetAll = options.resetAll ?? runtime.resetAll;
	const args = ["--monitor"];

	if (dryRun) args.push("--dry-run");
	if (refreshIds) args.push("--refresh-ids");
	if (resetAll) args.push("--reset=all");
	if (limit !== undefined) args.push(`--limit=${limit}`);
	if (fromIndex !== undefined) args.push(`--from-index=${fromIndex}`);

	return args;
}

export function buildAutomaticSyncArgs(): string[] {
	return ["--monitor", "--refresh-ids", "--from-index=0"];
}

export function hasApiStartedSyncProcess(): boolean {
	return activeSyncChild !== null;
}

export function isAnySyncActive(): boolean {
	return (
		hasApiStartedSyncProcess() ||
		SyncMonitor.isLikelyActive(readSyncMonitorStatus())
	);
}

export function startSyncProcess(
	args: string[],
	source: SyncStartSource,
): number {
	if (isAnySyncActive()) {
		throw new Error("A sync process is already active");
	}

	const config = getSyncMonitorPublicConfig();
	const code = ensureSyncMonitorAccessCode();
	writeSyncMonitorControlState(null, null, "sync");
	const command = ["bun", syncScriptPath, ...args];
	const env = {
		...process.env,
		ANICORE_SYNC_MONITOR: "1",
		ANICORE_SYNC_MONITOR_CODE: code,
		ANICORE_SYNC_MONITOR_DIR: config.statusPath.replace(/\/status\.json$/, ""),
	};
	const injectedNames = [
		"ANICORE_SYNC_MONITOR",
		"ANICORE_SYNC_MONITOR_CODE",
		"ANICORE_SYNC_MONITOR_DIR",
	] as const;
	processLog.info(
		JSON.stringify({
			event: "spawn.sync.starting",
			cmd: command[0],
			args: command.slice(1),
			cwd: apiRoot,
			source,
		}),
	);
	processLog.info(
		JSON.stringify({
			event: "env.sync.injected",
			names: injectedNames,
			missing: injectedNames.filter((name) => env[name] == null),
		}),
	);
	const child = Bun.spawn(command, {
		cwd: apiRoot,
		env,
		stdout: "inherit",
		stderr: "inherit",
		stdin: "ignore",
	});
	activeSyncChild = child;
	const startedMessage = `${source === "automatic" ? "Automatic" : "Manual"} sync process started with PID ${child.pid}`;
	safeAppendSyncEvent("info", startedMessage, {
		event: "spawn.sync.started",
		stage: source === "automatic" ? "automatic-sync" : "manual-sync",
		source,
		pid: child.pid,
	});

	void child.exited.then(
		(exitCode) => {
			if (activeSyncChild === child) activeSyncChild = null;
			const message = `Sync process ${child.pid} exited with code ${exitCode}`;
			const event = exitCode === 0 ? "spawn.sync.exited" : "spawn.sync.failed";
			processLog[exitCode === 0 ? "info" : "error"](
				JSON.stringify({ event, code: exitCode, pid: child.pid }),
			);
			safeAppendSyncEvent(exitCode === 0 ? "info" : "error", message, {
				event,
				stage: "process-exit",
				source,
				pid: child.pid,
				exitCode,
			});
		},
		(error) => {
			if (activeSyncChild === child) activeSyncChild = null;
			processLog.error(
				JSON.stringify({
					event: "spawn.sync.failed",
					err: error instanceof Error ? error.message : String(error),
					pid: child.pid,
				}),
			);
			safeAppendSyncEvent("error", "Failed to observe sync child exit", {
				event: "spawn.sync.failed",
				stage: "process-exit",
				source,
				pid: child.pid,
			});
		},
	);
	child.unref();
	return child.pid;
}

export async function stopApiStartedSyncProcess(
	gracePeriodMs = 5_000,
): Promise<void> {
	const child = activeSyncChild;
	if (!child) return;

	writeSyncMonitorControlState("stop", "API shutdown requested sync stop");
	const exited = child.exited.then(
		() => true,
		() => true,
	);
	const stoppedGracefully = await Promise.race([
		exited,
		new Promise<false>((resolve) =>
			setTimeout(() => resolve(false), gracePeriodMs),
		),
	]);
	if (stoppedGracefully) return;

	processLog.warn(
		JSON.stringify({ event: "spawn.sync.terminating", pid: child.pid }),
	);
	child.kill("SIGTERM");
	const terminated = await Promise.race([
		exited,
		new Promise<false>((resolve) =>
			setTimeout(() => resolve(false), 2_000),
		),
	]);
	if (!terminated) {
		processLog.error(
			JSON.stringify({ event: "spawn.sync.killing", pid: child.pid }),
		);
		child.kill("SIGKILL");
		await exited;
	}
}

function safeAppendSyncEvent(
	level: "info" | "warn" | "error",
	message: string,
	extra: Parameters<typeof appendSyncMonitorEvent>[2],
): void {
	try {
		appendSyncMonitorEvent(level, message, extra);
	} catch (error) {
		processLog.error(
			JSON.stringify({
				event: "file.sync_event.failed",
				err: error instanceof Error ? error.message : String(error),
			}),
		);
	}
}
