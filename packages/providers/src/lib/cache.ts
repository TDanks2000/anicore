import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { formatHttpError } from "./http";
import { log } from "./logger";

const CACHE_DIR = "data/cache";
const IDS_FILE = `${CACHE_DIR}/anilist_ids.txt`;
const PROGRESS_FILE = `${CACHE_DIR}/progress.json`;
const IDS_URLS = [
  "https://raw.githubusercontent.com/TDanks2000/anilistIds/refs/heads/main/anime_ids.txt",
  "https://raw.githubusercontent.com/TDanks2000/anilistIds/main/anime_ids.txt",
] as const;
const IDS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const UNMATCHED_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function ensureCacheDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
}

function parseIdText(text: string): number[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n) && n > 0);
}

function uniqueSortedIds(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

function serializeIds(ids: number[]): string {
  return ids.length ? `${ids.join("\n")}\n` : "";
}

// ── ID list ──────────────────────────────────────────────────────────────────

/** Downloads the canonical AniList ID list, deduplicated and sorted ascending. */
export async function fetchAnilistIdList(): Promise<number[]> {
  let lastError: Error | null = null;
  for (const url of IDS_URLS) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(await formatHttpError("Failed to fetch IDs", response));
      }

      return uniqueSortedIds(parseIdText(await response.text()));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("Failed to fetch the AniList ID list");
}

export async function loadIds(forceRefresh = false): Promise<number[]> {
  ensureCacheDir();

  const stale = !existsSync(IDS_FILE) || Date.now() - statSync(IDS_FILE).mtimeMs > IDS_CACHE_TTL_MS;

  if (forceRefresh || stale) {
    log.info("Downloading AniList ID list…");
    try {
      const remoteIds = await fetchAnilistIdList();
      const latestLocalIds = existsSync(IDS_FILE)
        ? parseIdText(readFileSync(IDS_FILE, "utf-8"))
        : [];
      const localIds = new Set(latestLocalIds);
      const missingRemoteIds = remoteIds.filter((id) => !localIds.has(id));

      // Never replace the live ID file during refresh. API on-demand imports can
      // append IDs from another process while this network request is in flight;
      // O_APPEND-style writes preserve both sides instead of letting a refresh
      // overwrite a newly discovered ID.
      appendFileSync(IDS_FILE, serializeIds(missingRemoteIds));
      const refreshedAt = new Date();
      utimesSync(IDS_FILE, refreshedAt, refreshedAt);
      log.success(`Refreshed → ${IDS_FILE}`);
    } catch (error) {
      if (existsSync(IDS_FILE)) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`Failed to refresh AniList ID list (${message}); using cached ${IDS_FILE}`);
      } else {
        throw error;
      }
    }
  }

  const text = await Bun.file(IDS_FILE).text();
  return uniqueSortedIds(parseIdText(text));
}

export interface AnilistIdsRefreshResult {
  total: number;
  added: number;
  keptLocal: number;
  bytes: number;
}

let activeIdsRefresh: Promise<AnilistIdsRefreshResult> | null = null;

/**
 * Fetches the canonical GitHub ID list and atomically replaces the live file
 * with it, which compacts duplicates and unsorted appends. IDs added to the
 * file while the request was in flight (on-demand imports) are preserved so a
 * refresh can never drop a newly discovered ID. Concurrent callers share one
 * request; the process only ever manages a single ID list.
 */
export function refreshAnilistIdsFile(path: string = IDS_FILE): Promise<AnilistIdsRefreshResult> {
  activeIdsRefresh ??= performAnilistIdsRefresh(path).finally(() => {
    activeIdsRefresh = null;
  });
  return activeIdsRefresh;
}

async function performAnilistIdsRefresh(path: string): Promise<AnilistIdsRefreshResult> {
  const remoteIds = await fetchAnilistIdList();
  const localIds = uniqueSortedIds(
    existsSync(path) ? parseIdText(readFileSync(path, "utf-8")) : [],
  );
  const localSet = new Set(localIds);
  const remoteSet = new Set(remoteIds);
  const merged = uniqueSortedIds([...remoteIds, ...localIds]);
  const added = remoteIds.filter((id) => !localSet.has(id)).length;
  const keptLocal = localIds.filter((id) => !remoteSet.has(id)).length;

  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(temporaryPath, serializeIds(merged));
    renameSync(temporaryPath, path);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }

  const bytes = statSync(path).size;
  log.success(`Refreshed and replaced AniList ID list → ${path}`);
  return { total: merged.length, added, keptLocal, bytes };
}

export function appendAnilistId(id: number): boolean {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid AniList ID: ${id}`);
  }

  ensureCacheDir();
  const existingIds = existsSync(IDS_FILE) ? parseIdText(readFileSync(IDS_FILE, "utf-8")) : [];

  if (existingIds.includes(id)) return false;

  // Appending a single line is cross-process safe in the way replacing the full
  // cache is not. Concurrent writers may create duplicate lines, which loadIds()
  // intentionally deduplicates in memory.
  appendFileSync(IDS_FILE, `${id}\n`);
  return true;
}

// ── Progress checkpoint ───────────────────────────────────────────────────────

export interface Progress {
  version: number;
  lastIndex: number;
  stats: { created: number; updated: number; failed: number };
}

const DEFAULT_PROGRESS: Progress = {
  version: 1,
  lastIndex: 0,
  stats: { created: 0, updated: 0, failed: 0 },
};

function defaultProgress(): Progress {
  return {
    version: DEFAULT_PROGRESS.version,
    lastIndex: DEFAULT_PROGRESS.lastIndex,
    stats: { ...DEFAULT_PROGRESS.stats },
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

export function parseProgress(value: unknown): Progress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const candidate = value as Record<string, unknown>;
  if (candidate.version !== DEFAULT_PROGRESS.version) return null;
  if (!isNonNegativeInteger(candidate.lastIndex)) return null;

  const rawStats = candidate.stats;
  if (!rawStats || typeof rawStats !== "object" || Array.isArray(rawStats)) {
    return null;
  }
  const stats = rawStats as Record<string, unknown>;
  if (
    !isNonNegativeInteger(stats.created) ||
    !isNonNegativeInteger(stats.updated) ||
    !isNonNegativeInteger(stats.failed)
  ) {
    return null;
  }

  return {
    version: DEFAULT_PROGRESS.version,
    lastIndex: candidate.lastIndex,
    stats: {
      created: stats.created,
      updated: stats.updated,
      failed: stats.failed,
    },
  };
}

export async function loadProgress(): Promise<Progress> {
  if (!existsSync(PROGRESS_FILE)) return defaultProgress();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(await Bun.file(PROGRESS_FILE).text());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Sync checkpoint ${PROGRESS_FILE} is unreadable: ${message}. Refusing to restart from index 0; repair the checkpoint or run an explicit reset.`,
    );
  }

  const progress = parseProgress(parsedJson);
  if (!progress) {
    throw new Error(
      `Sync checkpoint ${PROGRESS_FILE} has an invalid shape or unsupported version. Refusing to restart from index 0; repair the checkpoint or run an explicit reset.`,
    );
  }
  return progress;
}

export async function saveProgress(progress: Progress): Promise<void> {
  const validated = parseProgress(progress);
  if (!validated) {
    throw new Error("Refusing to write an invalid sync checkpoint");
  }

  ensureCacheDir();
  const temporaryPath = `${PROGRESS_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(validated, null, 2));
    renameSync(temporaryPath, PROGRESS_FILE);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

export async function resetProgress(): Promise<void> {
  if (existsSync(PROGRESS_FILE)) unlinkSync(PROGRESS_FILE);
}

// ── Per-provider unmatched tracking ──────────────────────────────────────────

function unmatchedPath(provider: string): string {
  return `${CACHE_DIR}/${provider}_unmatched.txt`;
}

interface UnmatchedCacheEntry {
  id: number;
  recordedAt: number;
}

function parseUnmatchedEntry(line: string): UnmatchedCacheEntry | null {
  const [idText, recordedAtText] = line.trim().split(/\s+/, 2);
  const id = Number(idText);
  const recordedAt = Number(recordedAtText);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (!Number.isFinite(recordedAt) || recordedAt <= 0) return null;
  return { id, recordedAt };
}

function serializeUnmatchedEntries(entries: UnmatchedCacheEntry[]): string {
  return entries.length
    ? `${entries.map((entry) => `${entry.id}\t${entry.recordedAt}`).join("\n")}\n`
    : "";
}

export function loadUnmatched(provider: string, nowMs = Date.now()): Set<number> {
  const path = unmatchedPath(provider);
  if (!existsSync(path)) return new Set();

  const latestById = new Map<number, UnmatchedCacheEntry>();
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const entry = parseUnmatchedEntry(line);
    if (!entry) continue;
    const previous = latestById.get(entry.id);
    if (!previous || entry.recordedAt > previous.recordedAt) {
      latestById.set(entry.id, entry);
    }
  }

  const activeEntries = [...latestById.values()]
    .filter(
      (entry) => entry.recordedAt <= nowMs && nowMs - entry.recordedAt <= UNMATCHED_CACHE_TTL_MS,
    )
    .sort((a, b) => a.id - b.id);

  // Compact the cache while loading so expired entries and the old bare-ID format
  // do not accumulate forever. Legacy entries intentionally expire on upgrade and
  // are retried once under the timestamped cache format.
  ensureCacheDir();
  writeFileSync(path, serializeUnmatchedEntries(activeEntries));

  return new Set(activeEntries.map((entry) => entry.id));
}

export function appendUnmatched(provider: string, id: number, recordedAt = Date.now()): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid unmatched AniList ID: ${id}`);
  }
  if (!Number.isFinite(recordedAt) || recordedAt <= 0) {
    throw new Error(`Invalid unmatched timestamp: ${recordedAt}`);
  }

  ensureCacheDir();
  appendFileSync(unmatchedPath(provider), `${id}\t${recordedAt}\n`);
}

export function clearUnmatched(provider: string): void {
  const path = unmatchedPath(provider);
  if (existsSync(path)) unlinkSync(path);
}

export function clearAllUnmatched(): void {
  if (!existsSync(CACHE_DIR)) return;
  for (const file of readdirSync(CACHE_DIR)) {
    if (file.endsWith("_unmatched.txt")) {
      unlinkSync(`${CACHE_DIR}/${file}`);
    }
  }
}
