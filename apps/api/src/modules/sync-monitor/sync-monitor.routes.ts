import type { SyncMonitorSnapshotResponse } from "@anicore/sync-monitor";
import { MAX_AUTO_SYNC_INTERVAL_MINUTES } from "@anicore/sync-monitor";
import { Elysia, t } from "elysia";

import { checkAutomaticSyncNow, getAutomaticSyncState } from "../../lib/automatic-sync";
import {
  clearDashboardCache,
  getDashboardResources,
  previewCache,
  updateDashboardProxy,
} from "../../lib/dashboard-resources";
import { conflict, HttpError } from "../../lib/errors";
import {
  getSyncMonitorFileInfo,
  getSyncMonitorPublicConfig,
  isSyncMonitorAuthorized,
  readSyncMonitorControlState,
  readSyncMonitorEvents,
  readSyncMonitorRuntimeConfig,
  readSyncMonitorStatus,
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

/**
 * A revision string that changes only when the dashboard-visible data changes.
 * The client uses it to skip re-renders on idle poll ticks.
 */
function buildRevision(input: {
  status: ReturnType<typeof readSyncMonitorStatus>;
  control: ReturnType<typeof readSyncMonitorControlState>;
  runtime: ReturnType<typeof readSyncMonitorRuntimeConfig>;
  automation: ReturnType<typeof getAutomaticSyncState>;
  events: ReturnType<typeof readSyncMonitorEvents>;
  active: boolean;
}): string {
  const lastEvent = input.events.at(-1);
  return [
    input.active ? "active" : "idle",
    input.status?.runId ?? "no-run",
    input.status?.state ?? "no-state",
    input.status?.updatedAt ?? "no-updated",
    input.control.command ?? "no-command",
    input.control.requestedAt ?? "no-requested",
    input.control.acknowledgedAt ?? "no-ack",
    input.runtime.updatedAt,
    input.automation.state,
    input.automation.lastCheckedAt ?? "no-check",
    input.automation.nextRunAt ?? "no-next",
    String(input.events.length),
    lastEvent ? `${lastEvent.at}|${lastEvent.message}` : "no-events",
  ].join("~");
}

function snapshotPayload(eventLimit: number): SyncMonitorSnapshotResponse {
  const status = readSyncMonitorStatus();
  const control = readSyncMonitorControlState();
  const runtime = readSyncMonitorRuntimeConfig();
  const automation = getAutomaticSyncState();
  const events = readSyncMonitorEvents(eventLimit);
  const active = isAnySyncActive();

  return {
    revision: buildRevision({ status, control, runtime, automation, events, active }),
    serverTime: new Date().toISOString(),
    status,
    active,
    control,
    files: getSyncMonitorFileInfo(),
    config: getSyncMonitorPublicConfig(),
    automation,
    events,
  };
}

function requestControl(command: "pause" | "resume" | "stop", message: string) {
  // Use the same definition of "active" the dashboard sees, so the button state
  // and the accepted command can never disagree.
  if (!isAnySyncActive()) {
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
  .get("/snapshot", ({ query }) => snapshotPayload(query.eventLimit), {
    query: t.Object({ eventLimit: t.Integer({ minimum: 1, maximum: 1000, default: 100 }) }),
  })
  .get("/events", ({ query }) => ({ events: readSyncMonitorEvents(query.limit) }), {
    query: t.Object({ limit: t.Integer({ minimum: 1, maximum: 1000, default: 100 }) }),
  })
  .get("/config", () => configPayload())
  .get("/resources", ({ query }) => getDashboardResources(query.offset), {
    query: t.Object({ offset: t.Integer({ minimum: 0, default: 0 }) }),
  })
  .patch(
    "/resources/proxy",
    ({ body }) => {
      updateDashboardProxy(body);
      return getDashboardResources();
    },
    {
      body: t.Object({
        mode: t.Optional(t.UnionEnum(["environment", "direct", "custom", "free"])),
        url: t.Optional(t.String({ maxLength: 4096 })),
        noProxy: t.Optional(t.String({ maxLength: 4096 })),
        maxAttempts: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
        timeoutMs: t.Optional(t.Integer({ minimum: 100, maximum: 60000 })),
      }),
    },
  )
  .get("/resources/cache", ({ query }) => previewCache(query.name), {
    query: t.Object({ name: t.String({ maxLength: 200 }) }),
  })
  .post(
    "/resources/cache/clear",
    ({ body }) => {
      if (isAnySyncActive()) throw conflict("Stop sync before clearing provider caches");
      clearDashboardCache(body.name);
      return { cleared: body.name };
    },
    { body: t.Object({ name: t.String({ maxLength: 200 }) }) },
  )
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
