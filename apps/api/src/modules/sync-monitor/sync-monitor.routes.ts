import { MAX_AUTO_SYNC_INTERVAL_MINUTES } from "@anicore/sync-monitor";
import { Elysia, t } from "elysia";

import { checkAutomaticSyncNow, getAutomaticSyncState } from "../../lib/automatic-sync";
import { conflict, HttpError } from "../../lib/errors";
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
import { buildSyncStartArgs, isAnySyncActive, startSyncProcess } from "../../lib/sync-process";

/**
 * Reads the monitor code from a bearer token, HTTP Basic credentials (the
 * password, so a browser prompt works) or the X-Sync-Monitor-Code header.
 */
export function extractMonitorAccessCode(headers: Record<string, string | undefined>) {
  const [, rawScheme, rawCredentials] = headers.authorization?.match(/^(\S+)\s+(.*)$/) ?? [];
  const scheme = rawScheme?.toLowerCase();
  const credentials = rawCredentials?.trim();

  if (scheme === "bearer") return credentials || null;
  if (scheme === "basic" && credentials) {
    const decoded = Buffer.from(credentials, "base64").toString("utf-8");
    const separator = decoded.indexOf(":");
    return separator === -1 ? decoded : decoded.slice(separator + 1);
  }
  return headers["x-sync-monitor-code"] ?? null;
}

function configPayload() {
  return { ...getSyncMonitorPublicConfig(), automation: getAutomaticSyncState() };
}

function controlPayload() {
  return {
    control: readSyncMonitorControlState(),
    status: readSyncMonitorStatus(),
    active: isAnySyncActive(),
  };
}

function requestControl(command: "pause" | "resume" | "stop", message: string) {
  if (!SyncMonitor.isLikelyActive(readSyncMonitorStatus())) {
    throw conflict(`No active sync process to ${command}`);
  }
  writeSyncMonitorControlState(command, message);
  return controlPayload();
}

export const syncMonitorRoutes = new Elysia({
  prefix: "/sync-monitor",
  detail: { tags: ["Sync monitor"] },
})
  .onBeforeHandle(({ headers, set }) => {
    if (!getSyncMonitorPublicConfig().enabled) {
      throw new HttpError(
        404,
        "Sync monitor is not enabled. Start sync with --monitor or set ANICORE_SYNC_MONITOR_CODE.",
      );
    }
    if (!isSyncMonitorAuthorized(extractMonitorAccessCode(headers))) {
      set.headers["WWW-Authenticate"] = 'Basic realm="AniCore Sync Monitor"';
      throw new HttpError(401, "Invalid sync monitor code");
    }
  })
  .get("/", () => ({
    status: readSyncMonitorStatus(),
    active: isAnySyncActive(),
    control: readSyncMonitorControlState(),
    files: getSyncMonitorFileInfo(),
  }))
  .get("/events", ({ query }) => ({ events: readSyncMonitorEvents(query.limit) }), {
    query: t.Object({ limit: t.Integer({ minimum: 1, maximum: 1000, default: 100 }) }),
  })
  .get("/config", () => configPayload())
  .patch(
    "/config",
    ({ body }) => {
      let patch: ReturnType<typeof validateSyncMonitorRuntimeConfigPatch>;
      try {
        patch = validateSyncMonitorRuntimeConfigPatch(body);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
      writeSyncMonitorRuntimeConfig(patch, "api");
      checkAutomaticSyncNow();
      return configPayload();
    },
    {
      body: t.Object({
        parallel: t.Optional(t.Number()),
        checkpointEvery: t.Optional(t.Number()),
        rateLimitMs: t.Optional(t.Number()),
        startMode: t.Optional(t.UnionEnum(["sync", "dry-run"])),
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
  .get("/control", () => controlPayload())
  .post("/control/pause", () => requestControl("pause", "Pause requested from monitor"))
  .post("/control/resume", () => requestControl("resume", "Resume requested from monitor"))
  .post("/control/stop", () => requestControl("stop", "Stop requested from monitor"))
  .post(
    "/control/start",
    ({ body }) => {
      if (isAnySyncActive()) throw conflict("A sync process is already active");
      const pid = startSyncProcess(buildSyncStartArgs(body), "api");
      return { ...controlPayload(), active: true, started: true, pid };
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
