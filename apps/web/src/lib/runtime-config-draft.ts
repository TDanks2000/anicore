import {
  DEFAULT_AUTO_SYNC_INTERVAL_MINUTES,
  MAX_AUTO_SYNC_INTERVAL_MINUTES,
  type SyncMonitorRuntimeConfig,
  type SyncMonitorRuntimeConfigPatch,
} from "@anicore/sync-monitor";

/** Form state for the runtime config card: numbers stay strings while edited. */
export interface RuntimeConfigDraft {
  parallel: string;
  checkpointEvery: string;
  rateLimitMs: string;
  startMode: "sync" | "dry-run";
  startLimit: string;
  startFromIndex: string;
  refreshIds: boolean;
  resetAll: boolean;
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: string;
}

export const DEFAULT_DRAFT: RuntimeConfigDraft = {
  parallel: "4",
  checkpointEvery: "10",
  rateLimitMs: "1500",
  startMode: "dry-run",
  startLimit: "5",
  startFromIndex: "",
  refreshIds: false,
  resetAll: false,
  autoSyncEnabled: true,
  autoSyncIntervalMinutes: String(DEFAULT_AUTO_SYNC_INTERVAL_MINUTES),
};

const optional = (value: number | null) => (value === null ? "" : String(value));

export function draftFromRuntime(runtime: SyncMonitorRuntimeConfig): RuntimeConfigDraft {
  return {
    parallel: String(runtime.parallel),
    checkpointEvery: String(runtime.checkpointEvery),
    rateLimitMs: String(runtime.rateLimitMs),
    startMode: runtime.startMode,
    startLimit: optional(runtime.startLimit),
    startFromIndex: optional(runtime.startFromIndex),
    refreshIds: runtime.refreshIds,
    resetAll: runtime.resetAll,
    autoSyncEnabled: runtime.autoSyncEnabled,
    autoSyncIntervalMinutes: String(runtime.autoSyncIntervalMinutes),
  };
}

function integerIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function isAutoSyncIntervalValid(draft: RuntimeConfigDraft): boolean {
  return (
    !draft.autoSyncEnabled ||
    integerIn(Number(draft.autoSyncIntervalMinutes), 1, MAX_AUTO_SYNC_INTERVAL_MINUTES)
  );
}

export type DraftParseResult =
  | { ok: true; patch: Required<SyncMonitorRuntimeConfigPatch> }
  | { ok: false; error: string };

/**
 * Validates a draft and converts it into a config patch. While automatic sync
 * is off its interval field is disabled, so the saved interval is kept.
 */
export function parseRuntimeConfigDraft(
  draft: RuntimeConfigDraft,
  savedIntervalMinutes: number,
): DraftParseResult {
  const parallel = Number(draft.parallel);
  const checkpointEvery = Number(draft.checkpointEvery);
  const rateLimitMs = Number(draft.rateLimitMs);
  const startLimit = draft.startLimit.trim() === "" ? null : Number(draft.startLimit);
  const startFromIndex = draft.startFromIndex.trim() === "" ? null : Number(draft.startFromIndex);
  const autoSyncIntervalMinutes = draft.autoSyncEnabled
    ? Number(draft.autoSyncIntervalMinutes)
    : savedIntervalMinutes;

  const fail = (error: string): DraftParseResult => ({ ok: false, error });
  if (!integerIn(parallel, 1, 32)) {
    return fail("Parallel fetches must be an integer between 1 and 32.");
  }
  if (!integerIn(checkpointEvery, 1, 10_000)) {
    return fail("Checkpoint every must be an integer between 1 and 10000.");
  }
  if (!integerIn(rateLimitMs, 1, 60_000)) {
    return fail("Rate limit must be an integer between 1 and 60000 ms.");
  }
  if (startLimit !== null && !integerIn(startLimit, 0, 1_000_000)) {
    return fail("Start limit must be empty or an integer from 0 to 1000000.");
  }
  if (startFromIndex !== null && !integerIn(startFromIndex, 0, 1_000_000)) {
    return fail("Start index must be empty or an integer from 0 to 1000000.");
  }
  if (!isAutoSyncIntervalValid(draft)) {
    return fail(
      `Automatic sync interval must be an integer from 1 to ${MAX_AUTO_SYNC_INTERVAL_MINUTES} minutes.`,
    );
  }

  return {
    ok: true,
    patch: {
      parallel,
      checkpointEvery,
      rateLimitMs,
      startMode: draft.startMode,
      startLimit,
      startFromIndex,
      refreshIds: draft.refreshIds,
      resetAll: draft.resetAll,
      autoSyncEnabled: draft.autoSyncEnabled,
      autoSyncIntervalMinutes,
    },
  };
}
