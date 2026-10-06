import { withRequestDeadline } from "./request";

export type SyncMonitorState =
  | "idle"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed";

export const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES = 24 * 60;
export const MAX_AUTO_SYNC_INTERVAL_MINUTES = 365 * 24 * 60;

export interface SyncMonitorStats {
  created: number;
  updated: number;
  failed: number;
  skipped?: number;
}

export interface SyncMonitorProgress {
  processed: number;
  remaining: number;
  percent: number;
  elapsedMs: number;
  ratePerMinute: number;
  etaSeconds: number | null;
}

export interface SyncMonitorBatch {
  startIndex: number;
  endIndex: number;
  size: number;
  concurrency: number;
  ids: number[];
  startedAt: string;
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
  progress: SyncMonitorProgress;
  activeBatch: SyncMonitorBatch | null;
  runtimeConfig: SyncMonitorRuntimeConfig;
  stats: SyncMonitorStats;
  lastError: string | null;
  recentErrors: string[];
}

export interface SyncMonitorRuntimeConfig {
  version: 1;
  parallel: number;
  checkpointEvery: number;
  rateLimitMs: number;
  startMode: "sync" | "dry-run";
  startLimit: number | null;
  startFromIndex: number | null;
  refreshIds: boolean;
  resetAll: boolean;
  newIdsOnly: boolean;
  idOrder: "ascending" | "descending";
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
  updatedAt: string;
  updatedBy: "default" | "api" | "sync";
}

export interface SyncMonitorRuntimeConfigPatch {
  parallel?: number;
  checkpointEvery?: number;
  rateLimitMs?: number;
  startMode?: "sync" | "dry-run";
  startLimit?: number | null;
  startFromIndex?: number | null;
  refreshIds?: boolean;
  resetAll?: boolean;
  newIdsOnly?: boolean;
  idOrder?: "ascending" | "descending";
  autoSyncEnabled?: boolean;
  autoSyncIntervalMinutes?: number;
}

export interface SyncMonitorAutomationStatus {
  state: "not-started" | "disabled" | "waiting" | "sync-active" | "error";
  lastCheckedAt: string | null;
  lastStartedAt: string | null;
  nextRunAt: string | null;
  lastMessage: string;
}

export type SyncMonitorControlCommand = "pause" | "resume" | "stop" | "start";

export interface SyncMonitorControlState {
  version: 1;
  command: Exclude<SyncMonitorControlCommand, "start"> | null;
  requestedAt: string | null;
  requestedBy: "api" | "sync" | null;
  message: string | null;
  /** Set by the sync loop once it has acted on the command; null while pending. */
  acknowledgedAt: string | null;
}

/** A command the API has queued but the sync loop has not acted on yet. */
export function isControlPending(control: SyncMonitorControlState | null | undefined): boolean {
  return Boolean(control?.command) && !control?.acknowledgedAt;
}

export interface SyncMonitorControlResponse {
  control: SyncMonitorControlState;
  status: SyncMonitorStatus | null;
  active: boolean;
}

export interface SyncMonitorStartOptions {
  dryRun?: boolean;
  limit?: number;
  fromIndex?: number;
  refreshIds?: boolean;
  resetAll?: boolean;
  newIdsOnly?: boolean;
  idOrder?: "ascending" | "descending";
}

export interface SyncMonitorStartResponse extends SyncMonitorControlResponse {
  started: boolean;
  pid: number | null;
}

export interface SyncMonitorEvent {
  at: string;
  event?: string;
  level: "info" | "warn" | "error";
  message: string;
  source?: "api" | "automatic";
  pid?: number;
  exitCode?: number;
  index?: number;
  anilistId?: number;
  stage?: string;
}

export interface SyncMonitorPublicConfig {
  enabled: boolean;
  statusPath: string;
  eventsPath: string;
  controlPath: string;
  runtimeConfigPath: string;
  codePath: string;
  hasAccessCode: boolean;
  runtime: SyncMonitorRuntimeConfig;
}

export interface SyncMonitorStatusResponse {
  status: SyncMonitorStatus | null;
  active: boolean;
  control: SyncMonitorControlState;
  files: SyncMonitorFileInfo;
}

export interface SyncMonitorFileInfo {
  statusExists: boolean;
  eventsExists: boolean;
  controlExists: boolean;
  runtimeConfigExists: boolean;
  statusUpdatedAt: string | null;
}

export interface SyncMonitorEventsResponse {
  events: SyncMonitorEvent[];
}

export interface SyncMonitorConfigResponse extends SyncMonitorPublicConfig {
  automation: SyncMonitorAutomationStatus;
}

/**
 * Everything the dashboard needs for one poll, read together so the pieces are
 * consistent. `revision` changes only when the underlying data changes, letting
 * the client skip re-renders on idle ticks.
 */
export interface SyncMonitorSnapshotResponse {
  revision: string;
  serverTime: string;
  status: SyncMonitorStatus | null;
  active: boolean;
  control: SyncMonitorControlState;
  files: SyncMonitorFileInfo;
  config: SyncMonitorPublicConfig;
  automation: SyncMonitorAutomationStatus;
  events: SyncMonitorEvent[];
}

export interface DashboardProxyPatch {
  mode?: "environment" | "direct" | "custom" | "free";
  url?: string;
  noProxy?: string;
  maxAttempts?: number;
  timeoutMs?: number;
}

/** Result of replacing the AniList ID list with the GitHub source. */
export interface AnilistIdsRefreshResponse {
  /** IDs in the file after the refresh. */
  total: number;
  /** Remote IDs that were not present locally. */
  added: number;
  /** Locally discovered IDs that the remote list does not publish. */
  keptLocal: number;
  bytes: number;
}

export interface DashboardResources {
  proxy: {
    mode: "environment" | "direct" | "custom" | "free";
    noProxy: string;
    maxAttempts: number;
    timeoutMs: number;
    hasCustomUrl: boolean;
    address: string | null;
    effectiveMode: "direct" | "custom" | "free";
    effectiveAddress: string | null;
    pools: { untested: number; working: number; dead: number };
  };
  cache: {
    files: { name: string; bytes: number; modifiedAt: string; clearable: boolean }[];
    offset: number;
    totalFiles: number;
    totalBytes: number;
  };
}

export interface SyncMonitorClientOptions {
  baseUrl: string;
  accessCode: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

/**
 * A non-2xx monitor response. Carries the HTTP status so callers can react to
 * a specific condition (for example a 409 conflict raised because the sync
 * process changed state between a poll and a command) instead of parsing the
 * message text.
 */
export class SyncMonitorRequestError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly detail: string | null;

  constructor(response: Response, detail: string | null) {
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    super(
      detail
        ? `Sync monitor request failed (${status}): ${detail}`
        : `Sync monitor request failed (${status})`,
    );
    this.name = "SyncMonitorRequestError";
    this.status = response.status;
    this.statusText = response.statusText;
    this.detail = detail;
  }
}

export class SyncMonitorClient {
  private readonly baseUrl: string;
  private readonly accessCode: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SyncMonitorClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.accessCode = options.accessCode;
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async getStatus(): Promise<SyncMonitorStatusResponse> {
    return this.getJson<SyncMonitorStatusResponse>("/sync-monitor/");
  }

  async getEvents(limit = 100): Promise<SyncMonitorEventsResponse> {
    return this.getJson<SyncMonitorEventsResponse>(
      `/sync-monitor/events?limit=${encodeURIComponent(String(limit))}`,
    );
  }

  async getConfig(): Promise<SyncMonitorConfigResponse> {
    return this.getJson<SyncMonitorConfigResponse>("/sync-monitor/config");
  }

  async getResources(offset = 0, signal?: AbortSignal): Promise<DashboardResources> {
    return this.getJson(`/sync-monitor/resources?offset=${encodeURIComponent(offset)}`, signal);
  }

  async updateProxy(patch: DashboardProxyPatch): Promise<DashboardResources> {
    return this.requestJson("/sync-monitor/resources/proxy", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  async previewCache(name: string): Promise<{ name: string; content: string; truncated: boolean }> {
    return this.getJson(`/sync-monitor/resources/cache?name=${encodeURIComponent(name)}`);
  }

  async clearCache(name: string): Promise<{ cleared: string }> {
    return this.postJson("/sync-monitor/resources/cache/clear", { name });
  }

  /** Downloads the GitHub ID list and replaces the API host's cached file. */
  async refreshAnilistIds(): Promise<AnilistIdsRefreshResponse> {
    return this.postJson<AnilistIdsRefreshResponse>("/sync-monitor/resources/anilist-ids/refresh");
  }

  /** One atomic read of status, control, config, automation and events. */
  async getSnapshot(eventLimit = 100, signal?: AbortSignal): Promise<SyncMonitorSnapshotResponse> {
    return this.getJson<SyncMonitorSnapshotResponse>(
      `/sync-monitor/snapshot?eventLimit=${encodeURIComponent(String(eventLimit))}`,
      signal,
    );
  }

  async updateConfig(patch: SyncMonitorRuntimeConfigPatch): Promise<SyncMonitorConfigResponse> {
    return this.requestJson<SyncMonitorConfigResponse>("/sync-monitor/config", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  async pause(): Promise<SyncMonitorControlResponse> {
    return this.postJson<SyncMonitorControlResponse>("/sync-monitor/control/pause");
  }

  async resume(): Promise<SyncMonitorControlResponse> {
    return this.postJson<SyncMonitorControlResponse>("/sync-monitor/control/resume");
  }

  async stop(): Promise<SyncMonitorControlResponse> {
    return this.postJson<SyncMonitorControlResponse>("/sync-monitor/control/stop");
  }

  async start(options: SyncMonitorStartOptions = {}): Promise<SyncMonitorStartResponse> {
    return this.postJson<SyncMonitorStartResponse>("/sync-monitor/control/start", options);
  }

  private async getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.requestJson<T>(path, {}, signal);
  }

  private async postJson<T>(path: string, body?: unknown): Promise<T> {
    return this.requestJson<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async requestJson<T>(
    path: string,
    init: Omit<RequestInit, "headers" | "signal"> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    return withRequestDeadline(
      async (requestSignal) => {
        const response = await this.fetcher(`${this.baseUrl}${path}`, {
          ...init,
          signal: requestSignal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.accessCode}`,
          },
        });

        if (!response.ok) {
          throw new SyncMonitorRequestError(response, await readErrorDetail(response));
        }

        return response.json() as Promise<T>;
      },
      signal,
      this.timeoutMs,
    );
  }
}

function hasErrorMessage(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  );
}

async function readErrorDetail(response: Response): Promise<string | null> {
  const contentType = response.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as unknown;
      if (hasErrorMessage(payload)) return payload.error;
      return JSON.stringify(payload);
    }

    const text = await response.text();
    return text.trim() || null;
  } catch {
    return null;
  }
}
