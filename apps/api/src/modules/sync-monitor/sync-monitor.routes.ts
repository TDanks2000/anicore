import { Elysia, t } from "elysia";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	ensureSyncMonitorAccessCode,
	getSyncMonitorFileInfo,
	getSyncMonitorPublicConfig,
	isSyncMonitorAuthorized,
	readSyncMonitorControlState,
	readSyncMonitorEvents,
	readSyncMonitorStatus,
	SyncMonitor,
	validateSyncMonitorRuntimeConfigPatch,
	writeSyncMonitorControlState,
	writeSyncMonitorRuntimeConfig,
} from "../../lib/sync-monitor";

const apiRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../..",
);
const syncScriptPath = resolve(apiRoot, "src/scripts/sync.ts");

function extractAccessCode(
	headers: Record<string, string | undefined>,
): string | null {
	const authorization = headers.authorization;
	if (authorization?.toLowerCase().startsWith("bearer ")) {
		return authorization.slice("bearer ".length).trim();
	}

	if (authorization?.toLowerCase().startsWith("basic ")) {
		try {
			const decoded = Buffer.from(
				authorization.slice("basic ".length).trim(),
				"base64",
			).toString("utf-8");
			const separatorIndex = decoded.indexOf(":");
			return separatorIndex === -1
				? decoded
				: decoded.slice(separatorIndex + 1);
		} catch {
			return null;
		}
	}

	return headers["x-sync-monitor-code"] ?? null;
}

function guard(
	headers: Record<string, string | undefined>,
	setStatus: (status: number) => void,
	setUnauthorizedHeader: () => void,
): { ok: true } | { ok: false; body: { error: string } } {
	const config = getSyncMonitorPublicConfig();
	if (!config.enabled) {
		setStatus(404);
		return {
			ok: false,
			body: {
				error:
					"Sync monitor is not enabled. Start sync with --monitor or set ANICORE_SYNC_MONITOR_CODE.",
			},
		};
	}

	if (!isSyncMonitorAuthorized(extractAccessCode(headers))) {
		setStatus(401);
		setUnauthorizedHeader();
		return { ok: false, body: { error: "Invalid sync monitor code" } };
	}

	return { ok: true };
}

function controlPayload() {
	const status = readSyncMonitorStatus();
	return {
		control: readSyncMonitorControlState(),
		status,
		active: SyncMonitor.isLikelyActive(status),
	};
}

function parseStartArgs(body: {
	dryRun?: boolean;
	limit?: number;
	fromIndex?: number;
	refreshIds?: boolean;
	resetAll?: boolean;
}): string[] {
	const runtime = getSyncMonitorPublicConfig().runtime;
	const dryRun = body.dryRun ?? runtime.startMode === "dry-run";
	const limit = body.limit ?? runtime.startLimit ?? undefined;
	const fromIndex = body.fromIndex ?? runtime.startFromIndex ?? undefined;
	const refreshIds = body.refreshIds ?? runtime.refreshIds;
	const resetAll = body.resetAll ?? runtime.resetAll;
	const args = ["--monitor"];

	if (dryRun) args.push("--dry-run");
	if (refreshIds) args.push("--refresh-ids");
	if (resetAll) args.push("--reset=all");
	if (limit !== undefined) args.push(`--limit=${limit}`);
	if (fromIndex !== undefined) args.push(`--from-index=${fromIndex}`);

	return args;
}

let activeSyncChild: ReturnType<typeof Bun.spawn> | null = null;

function hasApiStartedSyncProcess(): boolean {
	return activeSyncChild !== null;
}

function startSyncProcess(args: string[]): number {
	if (activeSyncChild) {
		throw new Error("A sync process started by this API is already active");
	}

	const config = getSyncMonitorPublicConfig();
	const code = ensureSyncMonitorAccessCode();
	const child = Bun.spawn(["bun", syncScriptPath, ...args], {
		cwd: apiRoot,
		env: {
			...process.env,
			ANICORE_SYNC_MONITOR: "1",
			ANICORE_SYNC_MONITOR_CODE: code,
			ANICORE_SYNC_MONITOR_DIR: config.statusPath.replace(/\/status\.json$/, ""),
		},
		stdout: "inherit",
		stderr: "inherit",
		stdin: "ignore",
	});
	activeSyncChild = child;
	void child.exited.then(
		() => {
			if (activeSyncChild === child) activeSyncChild = null;
		},
		() => {
			if (activeSyncChild === child) activeSyncChild = null;
		},
	);
	child.unref();
	return child.pid;
}

export const syncMonitorRoutes = new Elysia({ prefix: "/sync-monitor" })
	.get(
		"/",
		({ headers, set }) => {
			const auth = guard(
				headers,
				(status) => {
					set.status = status;
				},
				() => {
					set.headers["WWW-Authenticate"] =
						'Basic realm="AniCore Sync Monitor"';
				},
			);
			if (!auth.ok) return auth.body;

			const status = readSyncMonitorStatus();
			return {
				status,
				active: SyncMonitor.isLikelyActive(status),
				control: readSyncMonitorControlState(),
				files: getSyncMonitorFileInfo(),
			};
		},
	)
	.get(
		"/events",
		({ headers, query, set }) => {
			const auth = guard(
				headers,
				(status) => {
					set.status = status;
				},
				() => {
					set.headers["WWW-Authenticate"] =
						'Basic realm="AniCore Sync Monitor"';
				},
			);
			if (!auth.ok) return auth.body;

			const parsedLimit = query.limit ? Number(query.limit) : 100;
			const limit =
				Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100;

			return {
				events: readSyncMonitorEvents(limit),
			};
		},
		{
			query: t.Object({
				limit: t.Optional(t.String()),
			}),
		},
	)
	.get(
		"/config",
		({ headers, set }) => {
			const auth = guard(
				headers,
				(status) => {
					set.status = status;
				},
				() => {
					set.headers["WWW-Authenticate"] =
						'Basic realm="AniCore Sync Monitor"';
				},
			);
			if (!auth.ok) return auth.body;

			return getSyncMonitorPublicConfig();
		},
	)
	.patch(
		"/config",
		({ body, headers, set }) => {
			const auth = guard(
				headers,
				(status) => {
					set.status = status;
				},
				() => {
					set.headers["WWW-Authenticate"] =
						'Basic realm="AniCore Sync Monitor"';
				},
			);
			if (!auth.ok) return auth.body;

			try {
				const patch = validateSyncMonitorRuntimeConfigPatch(body);
				writeSyncMonitorRuntimeConfig(patch, "api");
				return getSyncMonitorPublicConfig();
			} catch (err) {
				set.status = 400;
				return {
					error: err instanceof Error ? err.message : String(err),
				};
			}
		},
		{
			body: t.Object({
				parallel: t.Optional(t.Number()),
				checkpointEvery: t.Optional(t.Number()),
				rateLimitMs: t.Optional(t.Number()),
				startMode: t.Optional(t.Union([t.Literal("sync"), t.Literal("dry-run")])),
				startLimit: t.Optional(t.Nullable(t.Number())),
				startFromIndex: t.Optional(t.Nullable(t.Number())),
				refreshIds: t.Optional(t.Boolean()),
				resetAll: t.Optional(t.Boolean()),
			}),
		},
	)
	.get(
		"/control",
		({ headers, set }) => {
			const auth = guard(
				headers,
				(status) => {
					set.status = status;
				},
				() => {
					set.headers["WWW-Authenticate"] =
						'Basic realm="AniCore Sync Monitor"';
				},
			);
			if (!auth.ok) return auth.body;

			return controlPayload();
		},
	)
	.post(
		"/control/pause",
		({ headers, set }) => {
			const auth = guard(
				headers,
				(status) => {
					set.status = status;
				},
				() => {
					set.headers["WWW-Authenticate"] =
						'Basic realm="AniCore Sync Monitor"';
				},
			);
			if (!auth.ok) return auth.body;

			const status = readSyncMonitorStatus();
			if (!SyncMonitor.isLikelyActive(status)) {
				set.status = 409;
				return { error: "No active sync process to pause" };
			}

			writeSyncMonitorControlState("pause", "Pause requested from monitor");
			return controlPayload();
		},
	)
	.post(
		"/control/resume",
		({ headers, set }) => {
			const auth = guard(
				headers,
				(status) => {
					set.status = status;
				},
				() => {
					set.headers["WWW-Authenticate"] =
						'Basic realm="AniCore Sync Monitor"';
				},
			);
			if (!auth.ok) return auth.body;

			const status = readSyncMonitorStatus();
			if (!SyncMonitor.isLikelyActive(status)) {
				set.status = 409;
				return { error: "No active sync process to resume" };
			}

			writeSyncMonitorControlState("resume", "Resume requested from monitor");
			return controlPayload();
		},
	)
	.post(
		"/control/stop",
		({ headers, set }) => {
			const auth = guard(
				headers,
				(status) => {
					set.status = status;
				},
				() => {
					set.headers["WWW-Authenticate"] =
						'Basic realm="AniCore Sync Monitor"';
				},
			);
			if (!auth.ok) return auth.body;

			const status = readSyncMonitorStatus();
			if (!SyncMonitor.isLikelyActive(status)) {
				set.status = 409;
				return { error: "No active sync process to stop" };
			}

			writeSyncMonitorControlState("stop", "Stop requested from monitor");
			return controlPayload();
		},
	)
	.post(
		"/control/start",
		({ body, headers, set }) => {
			const auth = guard(
				headers,
				(status) => {
					set.status = status;
				},
				() => {
					set.headers["WWW-Authenticate"] =
						'Basic realm="AniCore Sync Monitor"';
				},
			);
			if (!auth.ok) return auth.body;

			const status = readSyncMonitorStatus();
			if (SyncMonitor.isLikelyActive(status) || hasApiStartedSyncProcess()) {
				set.status = 409;
				return { error: "A sync process is already active" };
			}

			writeSyncMonitorControlState(null, null, "sync");
			const pid = startSyncProcess(parseStartArgs(body));
			const payload = controlPayload();
			return {
				...payload,
				active: true,
				started: true,
				pid,
			};
		},
		{
			body: t.Object({
				dryRun: t.Optional(t.Boolean()),
					limit: t.Optional(t.Integer({ minimum: 1, maximum: 1_000_000 })),
					fromIndex: t.Optional(t.Integer({ minimum: 0 })),
				refreshIds: t.Optional(t.Boolean()),
				resetAll: t.Optional(t.Boolean()),
			}),
		},
	);
