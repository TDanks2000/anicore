import {
  mkdirSync,
  existsSync,
  statSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
} from "node:fs";

import { log } from "./logger";
import { formatHttpError } from "./http";

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
    .filter((n) => !isNaN(n) && n > 0);
}

function uniqueSortedIds(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

function serializeIds(ids: number[]): string {
  return ids.length ? `${ids.join("\n")}\n` : "";
}

// ── ID list ──────────────────────────────────────────────────────────────────

export async function loadIds(forceRefresh = false): Promise<number[]> {
  ensureCacheDir();

  const stale =
    !existsSync(IDS_FILE) ||
    Date.now() - statSync(IDS_FILE).mtimeMs > IDS_CACHE_TTL_MS;

  if (forceRefresh || stale) {
    log.info("Downloading AniList ID list…");
    let lastError: Error | null = null;
    for (const url of IDS_URLS) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(await formatHttpError("Failed to fetch IDs", response));
        }

        const text = await response.text();
        // Re-read immediately before the synchronous replace so IDs appended while the
        // network request was in flight are preserved.
        const latestLocalIds = existsSync(IDS_FILE)
          ? parseIdText(readFileSync(IDS_FILE, "utf-8"))
          : [];
        writeFileSync(
          IDS_FILE,
          serializeIds(uniqueSortedIds([...latestLocalIds, ...parseIdText(text)])),
        );
        log.success(`Saved → ${IDS_FILE}`);
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (lastError) {
      if (existsSync(IDS_FILE)) {
        log.warn(
          `Failed to refresh AniList ID list (${lastError.message}); using cached ${IDS_FILE}`,
        );
      } else {
        throw lastError;
      }
    }
  }

  const text = await Bun.file(IDS_FILE).text();
  return parseIdText(text);
}

export function appendAnilistId(id: number): boolean {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid AniList ID: ${id}`);
  }

  ensureCacheDir();
  const existingIds = existsSync(IDS_FILE)
    ? parseIdText(readFileSync(IDS_FILE, "utf-8"))
    : [];

  if (existingIds.includes(id)) return false;

  const ids = uniqueSortedIds([...existingIds, id]);
  writeFileSync(IDS_FILE, serializeIds(ids));
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

export async function loadProgress(): Promise<Progress> {
  if (!existsSync(PROGRESS_FILE)) return { ...DEFAULT_PROGRESS };
  try {
    const text = await Bun.file(PROGRESS_FILE).text();
    return { ...DEFAULT_PROGRESS, ...JSON.parse(text) };
  } catch {
    return { ...DEFAULT_PROGRESS };
  }
}

export async function saveProgress(progress: Progress): Promise<void> {
  ensureCacheDir();
  await Bun.write(PROGRESS_FILE, JSON.stringify(progress, null, 2));
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
      (entry) =>
        entry.recordedAt <= nowMs && nowMs - entry.recordedAt <= UNMATCHED_CACHE_TTL_MS,
    )
    .sort((a, b) => a.id - b.id);

  // Compact the cache while loading so expired entries and the old bare-ID format
  // do not accumulate forever. Legacy entries intentionally expire on upgrade and
  // are retried once under the timestamped cache format.
  ensureCacheDir();
  writeFileSync(path, serializeUnmatchedEntries(activeEntries));

  return new Set(activeEntries.map((entry) => entry.id));
}

export function appendUnmatched(
  provider: string,
  id: number,
  recordedAt = Date.now(),
): void {
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
