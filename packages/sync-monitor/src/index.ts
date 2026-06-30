export type SyncMonitorState = "idle" | "running" | "completed" | "failed";

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

export interface SyncMonitorStatusResponse {
  status: SyncMonitorStatus | null;
  active: boolean;
  files: {
    statusExists: boolean;
    eventsExists: boolean;
    statusUpdatedAt: string | null;
  };
}

export interface SyncMonitorEventsResponse {
  events: SyncMonitorEvent[];
}

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

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.accessCode}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Sync monitor request failed: ${response.status}`);
    }

    return response.json() as Promise<T>;
  }
}
