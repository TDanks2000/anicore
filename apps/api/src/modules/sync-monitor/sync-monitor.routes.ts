import { Elysia, t } from "elysia";
import {
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
import {
	checkAutomaticSyncNow,
	getAutomaticSyncState,
} from "../../lib/automatic-sync";
import {
	buildSyncStartArgs,
	isAnySyncActive,
	startSyncProcess,
} from "../../lib/sync-process";
import { MAX_AUTO_SYNC_INTERVAL_MINUTES } from "@anicore/sync-monitor";

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
		active: isAnySyncActive(),
	};
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
				active: isAnySyncActive(),
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

			return {
				...getSyncMonitorPublicConfig(),
				automation: getAutomaticSyncState(),
			};
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
				checkAutomaticSyncNow();
				return {
					...getSyncMonitorPublicConfig(),
					automation: getAutomaticSyncState(),
				};
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
				autoSyncEnabled: t.Optional(t.Boolean()),
				autoSyncIntervalMinutes: t.Optional(
					t.Integer({ minimum: 1, maximum: MAX_AUTO_SYNC_INTERVAL_MINUTES }),
				),
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
			if (isAnySyncActive()) {
				set.status = 409;
				return { error: "A sync process is already active" };
			}

			const pid = startSyncProcess(buildSyncStartArgs(body), "api");
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
