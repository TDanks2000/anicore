import { Elysia, t } from "elysia";

import {
	getSyncMonitorFileInfo,
	getSyncMonitorPublicConfig,
	isSyncMonitorAuthorized,
	readSyncMonitorEvents,
	readSyncMonitorStatus,
	SyncMonitor,
} from "../../lib/sync-monitor";

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
	);
