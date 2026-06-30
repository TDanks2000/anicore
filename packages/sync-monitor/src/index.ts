export type SyncMonitorState =
  | "idle"
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed";

export interface SyncMonitorStats {
  created: number;
  updated: number;
  failed: number;
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
}

export type SyncMonitorControlCommand = "pause" | "resume" | "stop" | "start";

export interface SyncMonitorControlState {
  version: 1;
  command: Exclude<SyncMonitorControlCommand, "start"> | null;
  requestedAt: string | null;
  requestedBy: "api" | "sync" | null;
  message: string | null;
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
}

export interface SyncMonitorStartResponse extends SyncMonitorControlResponse {
  started: boolean;
  pid: number | null;
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
  files: {
    statusExists: boolean;
    eventsExists: boolean;
    controlExists: boolean;
    runtimeConfigExists: boolean;
    statusUpdatedAt: string | null;
  };
}

export interface SyncMonitorEventsResponse {
  events: SyncMonitorEvent[];
}

export interface SyncMonitorConfigResponse extends SyncMonitorPublicConfig {}

export interface SyncMonitorClientOptions {
  baseUrl: string;
  accessCode: string;
  fetcher?: typeof fetch;
}

export class SyncMonitorClient {
  private readonly baseUrl: string;
  private readonly accessCode: string;
  private readonly fetcher: typeof fetch;

  constructor(options: SyncMonitorClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.accessCode = options.accessCode;
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
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

  async updateConfig(
    patch: SyncMonitorRuntimeConfigPatch,
  ): Promise<SyncMonitorConfigResponse> {
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

  async start(
    options: SyncMonitorStartOptions = {},
  ): Promise<SyncMonitorStartResponse> {
    return this.postJson<SyncMonitorStartResponse>(
      "/sync-monitor/control/start",
      options,
    );
  }

  private async getJson<T>(path: string): Promise<T> {
    return this.requestJson<T>(path);
  }

  private async postJson<T>(path: string, body?: unknown): Promise<T> {
    return this.requestJson<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async requestJson<T>(
    path: string,
    init: Omit<RequestInit, "headers"> = {},
  ): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessCode}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Sync monitor request failed: ${response.status}`);
    }

    return response.json() as Promise<T>;
  }
}
