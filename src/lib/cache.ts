import {
  mkdirSync,
  existsSync,
  statSync,
  appendFileSync,
  readFileSync,
  unlinkSync,
  readdirSync,
} from "node:fs";

import { log } from "./logger";

const CACHE_DIR = "data/cache";
const IDS_FILE = `${CACHE_DIR}/anilist_ids.txt`;
const PROGRESS_FILE = `${CACHE_DIR}/progress.json`;
const IDS_URL =
  "https://raw.githubusercontent.com/TDanks2000/anilistIds/refs/heads/main/anime_ids.txt";
const IDS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function ensureCacheDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
}

// ── ID list ──────────────────────────────────────────────────────────────────

export async function loadIds(forceRefresh = false): Promise<number[]> {
  ensureCacheDir();

  const stale =
    !existsSync(IDS_FILE) ||
    Date.now() - statSync(IDS_FILE).mtimeMs > IDS_CACHE_TTL_MS;

  if (forceRefresh || stale) {
    log.info("Downloading AniList ID list…");
    const text = await fetch(IDS_URL).then((r) => {
      if (!r.ok) throw new Error(`Failed to fetch IDs: ${r.status}`);
      return r.text();
    });
    await Bun.write(IDS_FILE, text);
    log.success(`Saved → ${IDS_FILE}`);
  }

  const text = await Bun.file(IDS_FILE).text();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !isNaN(n) && n > 0);
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

export function loadUnmatched(provider: string): Set<number> {
  const path = unmatchedPath(provider);
  if (!existsSync(path)) return new Set();
  const text = readFileSync(path, "utf-8");
  return new Set(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => !isNaN(n)),
  );
}

export function appendUnmatched(provider: string, id: number): void {
  ensureCacheDir();
  appendFileSync(unmatchedPath(provider), `${id}\n`);
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
