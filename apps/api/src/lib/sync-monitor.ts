import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
	DEFAULT_AUTO_SYNC_INTERVAL_MINUTES,
	MAX_AUTO_SYNC_INTERVAL_MINUTES,
} from "@anicore/sync-monitor";
import type {
	SyncMonitorEvent,
	SyncMonitorBatch,
	SyncMonitorControlCommand,
	SyncMonitorControlState,
	SyncMonitorProgress,
	SyncMonitorPublicConfig,
	SyncMonitorRuntimeConfig,
	SyncMonitorRuntimeConfigPatch,
	SyncMonitorAutomationStatus,
	SyncMonitorStats,
	SyncMonitorStatus,
} from "@anicore/sync-monitor";

export type {
	SyncMonitorEvent,
	SyncMonitorBatch,
	SyncMonitorControlCommand,
	SyncMonitorControlState,
	SyncMonitorProgress,
	SyncMonitorPublicConfig,
	SyncMonitorRuntimeConfig,
	SyncMonitorRuntimeConfigPatch,
	SyncMonitorAutomationStatus,
	SyncMonitorStats,
	SyncMonitorStatus,
} from "@anicore/sync-monitor";

const MAX_RECENT_ERRORS = 20;
const MAX_EVENT_LINE_BYTES = 16 * 1024;
const MAX_ACTIVE_STATUS_SILENCE_MS = 30 * 60 * 1000;
const DEFAULT_PARALLEL = 4;
const DEFAULT_CHECKPOINT_EVERY = 10;
const DEFAULT_RATE_LIMIT_MS = 1500;
const MAX_PARALLEL = 32;
const MAX_CHECKPOINT_EVERY = 10_000;
const MAX_RATE_LIMIT_MS = 60_000;
const MAX_START_LIMIT = 1_000_000;

function monitorDir(): string {
	return process.env.ANICORE_SYNC_MONITOR_DIR ?? "data/sync-monitor";
}

function statusFile(): string {
	return `${monitorDir()}/status.json`;
}

function eventsFile(): string {
	return `${monitorDir()}/events.jsonl`;
}

function runtimeConfigFile(): string {
	return `${monitorDir()}/runtime-config.json`;
}

function controlFile(): string {
	return `${monitorDir()}/control.json`;
}

function automationHistoryFile(): string {
	return `${monitorDir()}/automation-history.json`;
}

function codeFile(): string {
	return `${monitorDir()}/access-code.txt`;
}

function ensureMonitorDir(): void {
	mkdirSync(monitorDir(), { recursive: true, mode: 0o700 });
	chmodSync(monitorDir(), 0o700);
}

function nowIso(): string {
	return new Date().toISOString();
}

function atomicWriteJson(path: string, value: unknown): void {
	ensureMonitorDir();
	const tmpPath = `${path}.tmp-${process.pid}`;
	writeFileSync(tmpPath, JSON.stringify(value, null, 2));
	renameSync(tmpPath, path);
}

function safeReadText(path: string): string | null {
	try {
		if (!existsSync(path)) return null;
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

function readAccessCode(): string | null {
	const fromEnv = process.env.ANICORE_SYNC_MONITOR_CODE?.trim();
	if (fromEnv) return fromEnv;
	return safeReadText(codeFile())?.trim() || null;
}

function parsePositiveInteger(value: unknown, name: string, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new Error(`${name} must be an integer`);
	}
	if (value < 1 || value > max) {
		throw new Error(`${name} must be between 1 and ${max}`);
	}
	return value;
}

function parseNonNegativeIntegerOrNull(
	value: unknown,
	name: string,
	max: number,
): number | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new Error(`${name} must be an integer`);
	}
	if (value < 0 || value > max) {
		throw new Error(`${name} must be between 0 and ${max}`);
	}
	return value;
}

function parseBoolean(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${name} must be a boolean`);
	}
	return value;
}

function defaultRuntimeConfig(): SyncMonitorRuntimeConfig {
	return {
		version: 1,
		parallel: DEFAULT_PARALLEL,
		checkpointEvery: DEFAULT_CHECKPOINT_EVERY,
		rateLimitMs: DEFAULT_RATE_LIMIT_MS,
		startMode: "dry-run",
		startLimit: 5,
		startFromIndex: null,
		refreshIds: false,
		resetAll: false,
		autoSyncEnabled: true,
		autoSyncIntervalMinutes: DEFAULT_AUTO_SYNC_INTERVAL_MINUTES,
		updatedAt: nowIso(),
		updatedBy: "default",
	};
}

function defaultControlState(): SyncMonitorControlState {
	return {
		version: 1,
		command: null,
		requestedAt: null,
		requestedBy: null,
		message: null,
	};
}

function normalizeControlState(value: unknown): SyncMonitorControlState {
	if (!value || typeof value !== "object") return defaultControlState();
	const input = value as Partial<SyncMonitorControlState>;
	const command =
		input.command === "pause" ||
		input.command === "resume" ||
		input.command === "stop"
			? input.command
			: null;

	return {
		version: 1,
		command,
		requestedAt:
			typeof input.requestedAt === "string" ? input.requestedAt : null,
		requestedBy:
			input.requestedBy === "api" || input.requestedBy === "sync"
				? input.requestedBy
				: null,
		message: typeof input.message === "string" ? input.message : null,
	};
}

function normalizeRuntimeConfig(
	value: unknown,
	fallback = defaultRuntimeConfig(),
): SyncMonitorRuntimeConfig {
	if (!value || typeof value !== "object") return fallback;
	const input = value as Partial<SyncMonitorRuntimeConfig>;

	try {
		return {
			version: 1,
			parallel: parsePositiveInteger(input.parallel, "parallel", MAX_PARALLEL),
			checkpointEvery: parsePositiveInteger(
				input.checkpointEvery,
				"checkpointEvery",
				MAX_CHECKPOINT_EVERY,
			),
			rateLimitMs: parsePositiveInteger(
				input.rateLimitMs,
				"rateLimitMs",
				MAX_RATE_LIMIT_MS,
			),
			startMode:
				input.startMode === "sync" || input.startMode === "dry-run"
					? input.startMode
					: fallback.startMode,
			startLimit:
				input.startLimit === null
					? null
					: parseNonNegativeIntegerOrNull(
							input.startLimit,
							"startLimit",
							MAX_START_LIMIT,
						),
			startFromIndex:
				input.startFromIndex === null
					? null
					: parseNonNegativeIntegerOrNull(
							input.startFromIndex,
							"startFromIndex",
							MAX_START_LIMIT,
						),
			refreshIds:
				typeof input.refreshIds === "boolean"
					? input.refreshIds
					: fallback.refreshIds,
			resetAll:
				typeof input.resetAll === "boolean" ? input.resetAll : fallback.resetAll,
			autoSyncEnabled:
				typeof input.autoSyncEnabled === "boolean"
					? input.autoSyncEnabled
					: fallback.autoSyncEnabled,
			autoSyncIntervalMinutes:
				input.autoSyncIntervalMinutes === undefined
					? fallback.autoSyncIntervalMinutes
					: parsePositiveInteger(
							input.autoSyncIntervalMinutes,
							"autoSyncIntervalMinutes",
							MAX_AUTO_SYNC_INTERVAL_MINUTES,
						),
			updatedAt:
				typeof input.updatedAt === "string" && input.updatedAt
					? input.updatedAt
					: fallback.updatedAt,
			updatedBy:
				input.updatedBy === "api" || input.updatedBy === "sync"
					? input.updatedBy
					: fallback.updatedBy,
		};
	} catch {
		return { ...fallback, autoSyncEnabled: false };
	}
}

export function readSyncMonitorControlState(): SyncMonitorControlState {
	const text = safeReadText(controlFile());
	if (!text) return defaultControlState();

	try {
		return normalizeControlState(JSON.parse(text));
	} catch {
		return defaultControlState();
	}
}

export function writeSyncMonitorControlState(
	command: Exclude<SyncMonitorControlCommand, "start"> | null,
	message: string | null,
	requestedBy: SyncMonitorControlState["requestedBy"] = "api",
): SyncMonitorControlState {
	const next: SyncMonitorControlState = {
		version: 1,
		command,
		requestedAt: command ? nowIso() : null,
		requestedBy: command ? requestedBy : null,
		message,
	};
	atomicWriteJson(controlFile(), next);
	return next;
}

export function readSyncMonitorRuntimeConfig(): SyncMonitorRuntimeConfig {
	const text = safeReadText(runtimeConfigFile());
	if (!text) return defaultRuntimeConfig();

	try {
		return normalizeRuntimeConfig(JSON.parse(text));
	} catch {
		return { ...defaultRuntimeConfig(), autoSyncEnabled: false };
	}
}

export function readLastSuccessfulSyncAt(): string | null {
	const text = safeReadText(automationHistoryFile());
	if (!text) return null;

	try {
		const value = JSON.parse(text) as { lastSuccessfulSyncAt?: unknown };
		return typeof value.lastSuccessfulSyncAt === "string"
			? value.lastSuccessfulSyncAt
			: null;
	} catch {
		return null;
	}
}

function writeLastSuccessfulSyncAt(at: string): void {
	atomicWriteJson(automationHistoryFile(), { version: 1, lastSuccessfulSyncAt: at });
}

export function writeSyncMonitorRuntimeConfig(
	patch: SyncMonitorRuntimeConfigPatch,
	updatedBy: SyncMonitorRuntimeConfig["updatedBy"],
): SyncMonitorRuntimeConfig {
	const current = readSyncMonitorRuntimeConfig();
	const next: SyncMonitorRuntimeConfig = {
		...current,
		...patch,
		version: 1,
		updatedAt: nowIso(),
		updatedBy,
	};
	const normalized = normalizeRuntimeConfig(next, current);
	atomicWriteJson(runtimeConfigFile(), normalized);
	return normalized;
}

export function validateSyncMonitorRuntimeConfigPatch(
	patch: SyncMonitorRuntimeConfigPatch,
): SyncMonitorRuntimeConfigPatch {
	const output: SyncMonitorRuntimeConfigPatch = {};

	if (patch.parallel !== undefined) {
		output.parallel = parsePositiveInteger(
			patch.parallel,
			"parallel",
			MAX_PARALLEL,
		);
	}

	if (patch.checkpointEvery !== undefined) {
		output.checkpointEvery = parsePositiveInteger(
			patch.checkpointEvery,
			"checkpointEvery",
			MAX_CHECKPOINT_EVERY,
		);
	}

	if (patch.rateLimitMs !== undefined) {
		output.rateLimitMs = parsePositiveInteger(
			patch.rateLimitMs,
			"rateLimitMs",
			MAX_RATE_LIMIT_MS,
		);
	}

	if (patch.startMode !== undefined) {
		if (patch.startMode !== "sync" && patch.startMode !== "dry-run") {
			throw new Error("startMode must be sync or dry-run");
		}
		output.startMode = patch.startMode;
	}

	if (patch.startLimit !== undefined) {
		output.startLimit = parseNonNegativeIntegerOrNull(
			patch.startLimit,
			"startLimit",
			MAX_START_LIMIT,
		);
	}

	if (patch.startFromIndex !== undefined) {
		output.startFromIndex = parseNonNegativeIntegerOrNull(
			patch.startFromIndex,
			"startFromIndex",
			MAX_START_LIMIT,
		);
	}

	if (patch.refreshIds !== undefined) {
		output.refreshIds = parseBoolean(patch.refreshIds, "refreshIds");
	}

	if (patch.resetAll !== undefined) {
		output.resetAll = parseBoolean(patch.resetAll, "resetAll");
	}

	if (patch.autoSyncEnabled !== undefined) {
		output.autoSyncEnabled = parseBoolean(
			patch.autoSyncEnabled,
			"autoSyncEnabled",
		);
	}

	if (patch.autoSyncIntervalMinutes !== undefined) {
		output.autoSyncIntervalMinutes = parsePositiveInteger(
			patch.autoSyncIntervalMinutes,
			"autoSyncIntervalMinutes",
			MAX_AUTO_SYNC_INTERVAL_MINUTES,
		);
	}

	if (Object.keys(output).length === 0) {
		throw new Error("At least one config setting must be supplied");
	}

	return output;
}

export function ensureSyncMonitorRuntimeConfig(
	overrides: SyncMonitorRuntimeConfigPatch = {},
): SyncMonitorRuntimeConfig {
	const current = readSyncMonitorRuntimeConfig();
	const shouldSeed =
		!existsSync(runtimeConfigFile()) || current.updatedBy === "default";
	if (!shouldSeed) return current;
	return writeSyncMonitorRuntimeConfig(overrides, "sync");
}

function secureEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

export function ensureSyncMonitorAccessCode(): string {
	const existing = readAccessCode();
	if (existing) {
		if (existsSync(codeFile())) {
			ensureMonitorDir();
			chmodSync(codeFile(), 0o600);
		}
		return existing;
	}

	ensureMonitorDir();
	const code = randomBytes(24).toString("base64url");
	writeFileSync(codeFile(), `${code}\n`, { mode: 0o600 });
	chmodSync(codeFile(), 0o600);
	return code;
}

export function isSyncMonitorAuthorized(candidate: string | null): boolean {
	if (!candidate) return false;
	const code = readAccessCode();
	if (!code) return false;
	return secureEqual(candidate.trim(), code);
}

export function getSyncMonitorPublicConfig(): SyncMonitorPublicConfig {
	const hasAccessCode = Boolean(readAccessCode());
	return {
		enabled: hasAccessCode,
		statusPath: statusFile(),
		eventsPath: eventsFile(),
		controlPath: controlFile(),
		runtimeConfigPath: runtimeConfigFile(),
		codePath: codeFile(),
		hasAccessCode,
		runtime: readSyncMonitorRuntimeConfig(),
	};
}

export function readSyncMonitorStatus(): SyncMonitorStatus | null {
	const text = safeReadText(statusFile());
	if (!text) return null;

	try {
		const status = JSON.parse(text) as SyncMonitorStatus;
		return {
			...status,
			runtimeConfig: normalizeRuntimeConfig(status.runtimeConfig),
		};
	} catch {
		return null;
	}
}

export function readSyncMonitorEvents(limit = 100): SyncMonitorEvent[] {
	const boundedLimit = Math.max(1, Math.min(limit, 500));
	const text = safeReadText(eventsFile());
	if (!text) return [];

	const lines = text
		.split("\n")
		.filter(Boolean)
		.slice(-boundedLimit);

	const events: SyncMonitorEvent[] = [];
	for (const line of lines) {
		if (Buffer.byteLength(line) > MAX_EVENT_LINE_BYTES) continue;
		try {
			events.push(JSON.parse(line) as SyncMonitorEvent);
		} catch {
			// Ignore partial lines left by interrupted writes.
		}
	}
	return events;
}

export function appendSyncMonitorEvent(
	level: SyncMonitorEvent["level"],
	message: string,
	extra: Omit<SyncMonitorEvent, "at" | "level" | "message"> = {},
): void {
	ensureMonitorDir();
	const event: SyncMonitorEvent = { at: nowIso(), level, message, ...extra };
	appendFileSync(eventsFile(), `${JSON.stringify(event)}\n`);
}

export class SyncMonitor {
	private status: SyncMonitorStatus;

	constructor(input: {
		mode: SyncMonitorStatus["mode"];
		total: number;
		startIndex: number;
		endIndex: number;
		parallel: number;
		providers: string[];
	}) {
		writeSyncMonitorControlState(null, null, "sync");
		const at = nowIso();
		this.status = {
			version: 1,
			runId: `${at.replace(/[:.]/g, "-")}-${process.pid}`,
			state: "running",
			mode: input.mode,
			pid: process.pid,
			startedAt: at,
			updatedAt: at,
			total: input.total,
			startIndex: input.startIndex,
			endIndex: input.endIndex,
			currentIndex: null,
			currentAnilistId: null,
			currentStage: "starting",
			parallel: input.parallel,
			providers: input.providers,
			progress: calculateProgress({
				stats: { created: 0, updated: 0, failed: 0 },
				total: input.total,
				startedAt: at,
			}),
			activeBatch: null,
			runtimeConfig: readSyncMonitorRuntimeConfig(),
			stats: { created: 0, updated: 0, failed: 0 },
			lastError: null,
			recentErrors: [],
		};
		ensureMonitorDir();
		this.writeStatus();
		this.event("info", "Sync monitor started", { stage: "starting" });
	}

	static isLikelyActive(status: SyncMonitorStatus | null): boolean {
		if (
			!status ||
			!["running", "paused", "stopping"].includes(status.state)
		) {
			return false;
		}
		if (status.state !== "paused") {
			const updatedAt = Date.parse(status.updatedAt);
			if (
				!Number.isFinite(updatedAt) ||
				Date.now() - updatedAt > MAX_ACTIVE_STATUS_SILENCE_MS
			) {
				return false;
			}
		}
		try {
			process.kill(status.pid, 0);
			return true;
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "EPERM"
			) {
				return true;
			}
			return false;
		}
	}

	update(
		patch: Partial<
			Pick<
				SyncMonitorStatus,
				| "currentIndex"
				| "currentAnilistId"
				| "currentStage"
				| "stats"
				| "lastError"
				| "parallel"
				| "activeBatch"
				| "runtimeConfig"
				| "state"
			>
		>,
	): void {
		const updatedAt = nowIso();
		const next = { ...this.status, ...patch, updatedAt };
		this.status = {
			...next,
			progress: calculateProgress({
				stats: next.stats,
				total: next.total,
				startedAt: next.startedAt,
			}),
		};
		this.writeStatus();
	}

	stage(stage: string, index?: number, anilistId?: number): void {
		this.update({
			currentStage: stage,
			currentIndex: index ?? this.status.currentIndex,
			currentAnilistId: anilistId ?? this.status.currentAnilistId,
		});
	}

	recordError(message: string, index?: number, anilistId?: number): void {
		const recentErrors = [...this.status.recentErrors, message].slice(
			-MAX_RECENT_ERRORS,
		);
		const updatedAt = nowIso();
		this.status = {
			...this.status,
			lastError: message,
			recentErrors,
			updatedAt,
			progress: calculateProgress({
				stats: this.status.stats,
				total: this.status.total,
				startedAt: this.status.startedAt,
			}),
		};
		this.writeStatus();
		this.event("error", message, { index, anilistId });
	}

	event(
		level: SyncMonitorEvent["level"],
		message: string,
		extra: Omit<SyncMonitorEvent, "at" | "level" | "message"> = {},
	): void {
		appendSyncMonitorEvent(level, message, extra);
	}

	complete(stats: SyncMonitorStats): void {
		const at = nowIso();
		this.status = {
			...this.status,
			state: "completed",
			stats,
			currentStage: "complete",
			activeBatch: null,
			updatedAt: at,
			completedAt: at,
			progress: calculateProgress({
				stats,
				total: this.status.total,
				startedAt: this.status.startedAt,
				endedAt: at,
			}),
		};
		this.writeStatus();
		if (this.status.mode === "sync") {
			try {
				writeLastSuccessfulSyncAt(at);
			} catch (error) {
				console.error(
					JSON.stringify({
						event: "file.sync_history.failed",
						err: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		}
		this.event("info", "Sync complete", { stage: "complete" });
	}

	fail(message: string): void {
		const at = nowIso();
		this.status = {
			...this.status,
			state: "failed",
			lastError: message,
			activeBatch: null,
			recentErrors: [...this.status.recentErrors, message].slice(
				-MAX_RECENT_ERRORS,
			),
			updatedAt: at,
			completedAt: at,
			progress: calculateProgress({
				stats: this.status.stats,
				total: this.status.total,
				startedAt: this.status.startedAt,
				endedAt: at,
			}),
		};
		this.writeStatus();
		this.event("error", message);
	}

	pause(message = "Sync paused"): void {
		this.update({
			state: "paused",
			currentStage: "paused",
			activeBatch: null,
		});
		this.event("info", message, { stage: "paused" });
	}

	resume(message = "Sync resumed"): void {
		this.update({ state: "running", currentStage: "resuming" });
		this.event("info", message, { stage: "running" });
	}

	stopping(message = "Sync stopping"): void {
		this.update({
			state: "stopping",
			currentStage: "stopping",
			activeBatch: null,
		});
		this.event("warn", message, { stage: "stopping" });
	}

	stop(stats: SyncMonitorStats): void {
		const at = nowIso();
		this.status = {
			...this.status,
			state: "stopped",
			stats,
			currentStage: "stopped",
			activeBatch: null,
			updatedAt: at,
			completedAt: at,
			progress: calculateProgress({
				stats,
				total: this.status.total,
				startedAt: this.status.startedAt,
				endedAt: at,
			}),
		};
		this.writeStatus();
		this.event("warn", "Sync stopped", { stage: "stopped" });
	}

	private writeStatus(): void {
		atomicWriteJson(statusFile(), this.status);
	}
}

export function createSyncMonitorBatch(input: {
	startIndex: number;
	endIndex: number;
	concurrency: number;
	ids: number[];
}): SyncMonitorBatch {
	return {
		...input,
		size: input.ids.length,
		startedAt: nowIso(),
	};
}

function calculateProgress(input: {
	stats: SyncMonitorStats;
	total: number;
	startedAt: string;
	endedAt?: string;
}): SyncMonitorProgress {
	const processed =
		input.stats.created + input.stats.updated + input.stats.failed;
	const remaining = Math.max(0, input.total - processed);
	const percent =
		input.total > 0
			? Math.max(0, Math.min(100, Math.round((processed / input.total) * 100)))
			: 0;
	const startMs = new Date(input.startedAt).getTime();
	const endMs = input.endedAt ? new Date(input.endedAt).getTime() : Date.now();
	const elapsedMs = Math.max(0, endMs - startMs);
	const ratePerMinute = elapsedMs > 0 ? (processed / elapsedMs) * 60_000 : 0;
	const etaSeconds =
		ratePerMinute > 0 ? Math.ceil((remaining / ratePerMinute) * 60) : null;

	return {
		processed,
		remaining,
		percent,
		elapsedMs,
		ratePerMinute,
		etaSeconds,
	};
}

export function getSyncMonitorFileInfo(): {
	statusExists: boolean;
	eventsExists: boolean;
	controlExists: boolean;
	runtimeConfigExists: boolean;
	statusUpdatedAt: string | null;
} {
	const path = statusFile();
	const statusExists = existsSync(path);
	const eventsExists = existsSync(eventsFile());
	const controlExists = existsSync(controlFile());
	const runtimeConfigExists = existsSync(runtimeConfigFile());
	return {
		statusExists,
		eventsExists,
		controlExists,
		runtimeConfigExists,
		statusUpdatedAt: statusExists
			? new Date(statSync(path).mtimeMs).toISOString()
			: null,
	};
}
