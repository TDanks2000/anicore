import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";

export type SyncMonitorState =
	| "idle"
	| "running"
	| "completed"
	| "failed";

export interface SyncMonitorStats {
	created: number;
	updated: number;
	failed: number;
}

export interface SyncMonitorStatus {
	version: 1;
	runId: string;
	state: SyncMonitorState;
	mode: "sync" | "dry-run" | "provider-reset" | "verify";
	pid: number;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	total: number;
	startIndex: number;
	endIndex: number;
	currentIndex: number | null;
	currentAnilistId: number | null;
	currentStage: string | null;
	parallel: number;
	providers: string[];
	stats: SyncMonitorStats;
	lastError: string | null;
	recentErrors: string[];
}

export interface SyncMonitorEvent {
	at: string;
	level: "info" | "warn" | "error";
	message: string;
	index?: number;
	anilistId?: number;
	stage?: string;
}

export interface SyncMonitorPublicConfig {
	enabled: boolean;
	statusPath: string;
	eventsPath: string;
	codePath: string;
	hasAccessCode: boolean;
}

const MAX_RECENT_ERRORS = 20;
const MAX_EVENT_LINE_BYTES = 16 * 1024;

function monitorDir(): string {
	return process.env.ANICORE_SYNC_MONITOR_DIR ?? "data/sync-monitor";
}

function statusFile(): string {
	return `${monitorDir()}/status.json`;
}

function eventsFile(): string {
	return `${monitorDir()}/events.jsonl`;
}

function codeFile(): string {
	return `${monitorDir()}/access-code.txt`;
}

function ensureMonitorDir(): void {
	mkdirSync(monitorDir(), { recursive: true });
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

function secureEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

export function ensureSyncMonitorAccessCode(): string {
	const existing = readAccessCode();
	if (existing) return existing;

	ensureMonitorDir();
	const code = randomBytes(24).toString("base64url");
	writeFileSync(codeFile(), `${code}\n`);
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
		codePath: codeFile(),
		hasAccessCode,
	};
}

export function readSyncMonitorStatus(): SyncMonitorStatus | null {
	const text = safeReadText(statusFile());
	if (!text) return null;

	try {
		return JSON.parse(text) as SyncMonitorStatus;
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
			stats: { created: 0, updated: 0, failed: 0 },
			lastError: null,
			recentErrors: [],
		};
		ensureMonitorDir();
		this.writeStatus();
		this.event("info", "Sync monitor started", { stage: "starting" });
	}

	static isLikelyActive(status: SyncMonitorStatus | null): boolean {
		if (!status || status.state !== "running") return false;
		try {
			process.kill(status.pid, 0);
			return true;
		} catch {
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
			>
		>,
	): void {
		this.status = { ...this.status, ...patch, updatedAt: nowIso() };
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
		this.status = {
			...this.status,
			lastError: message,
			recentErrors,
			updatedAt: nowIso(),
		};
		this.writeStatus();
		this.event("error", message, { index, anilistId });
	}

	event(
		level: SyncMonitorEvent["level"],
		message: string,
		extra: Omit<SyncMonitorEvent, "at" | "level" | "message"> = {},
	): void {
		ensureMonitorDir();
		const event: SyncMonitorEvent = { at: nowIso(), level, message, ...extra };
		appendFileSync(eventsFile(), `${JSON.stringify(event)}\n`);
	}

	complete(stats: SyncMonitorStats): void {
		const at = nowIso();
		this.status = {
			...this.status,
			state: "completed",
			stats,
			currentStage: "complete",
			updatedAt: at,
			completedAt: at,
		};
		this.writeStatus();
		this.event("info", "Sync complete", { stage: "complete" });
	}

	fail(message: string): void {
		const at = nowIso();
		this.status = {
			...this.status,
			state: "failed",
			lastError: message,
			recentErrors: [...this.status.recentErrors, message].slice(
				-MAX_RECENT_ERRORS,
			),
			updatedAt: at,
			completedAt: at,
		};
		this.writeStatus();
		this.event("error", message);
	}

	private writeStatus(): void {
		atomicWriteJson(statusFile(), this.status);
	}
}

export function getSyncMonitorFileInfo(): {
	statusExists: boolean;
	eventsExists: boolean;
	statusUpdatedAt: string | null;
} {
	const path = statusFile();
	const statusExists = existsSync(path);
	const eventsExists = existsSync(eventsFile());
	return {
		statusExists,
		eventsExists,
		statusUpdatedAt: statusExists
			? new Date(statSync(path).mtimeMs).toISOString()
			: null,
	};
}
