import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { closeDb } from "@anicore/db";
import { type KitsuSearchNode, searchKitsuByTitle } from "@anicore/providers/kitsu/client";
import { sql } from "drizzle-orm";
// `matching.ts` is intentionally not exported from @anicore/providers' package.json
// exports map, so it is reached with a relative path into the package's source
// instead of inventing a new public subpath for a one-off measurement script.
import {
  kitsuSearchTitles,
  type MatchHints,
} from "../../../../packages/providers/src/providers/kitsu/matching";
import { queryRows } from "../lib/query-rows";

const DEFAULT_SAMPLE_SIZE = 300;
const DEFAULT_SEED = 1;
const DEFAULT_OUT_PATH = "data/eval/kitsu-matching-corpus.json";
const REQUEST_DELAY_MS = 200;
const PROGRESS_INTERVAL = 25;

export interface KitsuMatchingCorpusCase {
  hints: MatchHints;
  expectedKitsuId: string;
  candidates: KitsuSearchNode[];
}

export interface KitsuMatchingCorpus {
  generatedAt: string;
  seed: number;
  sampleSize: number;
  cases: KitsuMatchingCorpusCase[];
}

interface AuthoritativeKitsuMappingRow extends Record<string, unknown> {
  animeId: number;
  titleRomaji: string;
  titleEnglish: string | null;
  titleNative: string | null;
  synonymsJson: string;
  season: string | null;
  seasonYear: number | null;
  startDate: string | null;
  episodeCount: number | null;
  format: string | null;
  anilistId: string;
  expectedKitsuId: string;
}

export interface CorpusCommandOptions {
  sampleSize: number;
  seed: number;
  outPath: string;
}

export function parseCorpusCommandArgs(args: string[], cwd = process.cwd()): CorpusCommandOptions {
  let sampleSize = DEFAULT_SAMPLE_SIZE;
  let seed = DEFAULT_SEED;
  let outPath = resolve(cwd, DEFAULT_OUT_PATH);

  for (const arg of args) {
    if (arg.startsWith("--sample=")) {
      const value = Number(arg.slice("--sample=".length));
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--sample must be a positive integer, received: ${arg}`);
      }
      sampleSize = value;
      continue;
    }

    if (arg.startsWith("--seed=")) {
      const value = Number(arg.slice("--seed=".length));
      if (!Number.isInteger(value)) {
        throw new Error(`--seed must be an integer, received: ${arg}`);
      }
      seed = value;
      continue;
    }

    if (arg.startsWith("--out=")) {
      const value = arg.slice("--out=".length).trim();
      if (!value) {
        throw new Error("--out= requires a non-empty file path");
      }
      outPath = isAbsolute(value) ? value : resolve(cwd, value);
      continue;
    }

    throw new Error(`Unknown evaluate-kitsu-matching-corpus argument: ${arg}`);
  }

  return { sampleSize, seed, outPath };
}

/**
 * Every anime that carries an authoritative (`source = 'api'`) Kitsu mapping,
 * i.e. Kitsu itself published an `ANILIST_ANIME` cross-reference pointing at
 * this AniList anime. Joined against the anime's own `anilist` mapping row to
 * recover the true AniList id (`anime.id` is a local surrogate key, not the
 * AniList media id — see the report for the verification trail).
 *
 * `distinct on (a.id)` plus a deterministic tiebreak keeps the query stable
 * even if an anime were ever to carry more than one row for a provider.
 */
async function loadAuthoritativeRows(): Promise<AuthoritativeKitsuMappingRow[]> {
  return queryRows<AuthoritativeKitsuMappingRow>(sql`
    select distinct on (a.id)
      a.id as "animeId",
      a.title_romaji as "titleRomaji",
      a.title_english as "titleEnglish",
      a.title_native as "titleNative",
      a.synonyms_json as "synonymsJson",
      a.season,
      a.season_year as "seasonYear",
      a.start_date as "startDate",
      a.episode_count as "episodeCount",
      a.format,
      anilist.provider_id as "anilistId",
      kitsu.provider_id as "expectedKitsuId"
    from anime a
    join anime_mappings anilist
      on anilist.anime_id = a.id and anilist.provider = 'anilist'
    join anime_mappings kitsu
      on kitsu.anime_id = a.id and kitsu.provider = 'kitsu' and kitsu.source = 'api'
    order by a.id, anilist.is_primary desc, anilist.id, kitsu.is_primary desc, kitsu.id
  `);
}

function parseSynonyms(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function buildHints(row: AuthoritativeKitsuMappingRow): MatchHints {
  return {
    anilistId: row.anilistId,
    titleRomaji: row.titleRomaji,
    titleEnglish: row.titleEnglish,
    titleNative: row.titleNative,
    synonyms: parseSynonyms(row.synonymsJson),
    season: row.season,
    seasonYear: row.seasonYear,
    startDate: row.startDate,
    episodeCount: row.episodeCount,
    format: row.format,
  };
}

function normalizeFormatKey(format: string | null): string {
  return format?.trim() || "UNKNOWN";
}

/** Deterministic PRNG (mulberry32) so the same seed always yields the same sample. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function random(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleDeterministic<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = result[index]!;
    result[index] = result[swapIndex]!;
    result[swapIndex] = current;
  }
  return result;
}

/**
 * Samples `sampleSize` rows, stratified by `format` proportionally to the
 * population, using the largest-remainder method so per-format quotas sum
 * exactly to `sampleSize` (capped by each format's population). Selection
 * within a format is a seeded Fisher-Yates shuffle, so re-running with the
 * same `seed` always yields the same sample.
 */
export function stratifiedSample(
  rows: AuthoritativeKitsuMappingRow[],
  sampleSize: number,
  seed: number,
): AuthoritativeKitsuMappingRow[] {
  if (rows.length <= sampleSize) {
    return [...rows].sort((a, b) => a.animeId - b.animeId);
  }

  const groups = new Map<string, AuthoritativeKitsuMappingRow[]>();
  for (const row of rows) {
    const key = normalizeFormatKey(row.format);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const formatKeys = [...groups.keys()].sort();
  const total = rows.length;

  const quotas = formatKeys.map((key) => {
    const groupSize = groups.get(key)!.length;
    const raw = (groupSize / total) * sampleSize;
    const floor = Math.floor(raw);
    return { key, groupSize, floor, remainder: raw - floor };
  });

  const desired = new Map(quotas.map((quota) => [quota.key, quota.floor]));
  let remaining = sampleSize - quotas.reduce((sum, quota) => sum + quota.floor, 0);

  const byRemainder = [...quotas].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return a.key.localeCompare(b.key);
  });

  for (const quota of byRemainder) {
    if (remaining <= 0) break;
    const current = desired.get(quota.key)!;
    if (current >= quota.groupSize) continue;
    desired.set(quota.key, current + 1);
    remaining -= 1;
  }

  const random = mulberry32(seed);
  const sampled: AuthoritativeKitsuMappingRow[] = [];
  for (const key of formatKeys) {
    const group = [...groups.get(key)!].sort((a, b) => a.animeId - b.animeId);
    const shuffled = shuffleDeterministic(group, random);
    const count = Math.min(desired.get(key) ?? 0, group.length);
    sampled.push(...shuffled.slice(0, count));
  }

  return sampled.sort((a, b) => a.animeId - b.animeId);
}

function isValidExistingCase(value: unknown): value is KitsuMatchingCorpusCase {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.expectedKitsuId !== "string") return false;
  if (!Array.isArray(record.candidates)) return false;
  if (typeof record.hints !== "object" || record.hints === null) return false;
  return typeof (record.hints as Record<string, unknown>).anilistId === "string";
}

/**
 * Loads a previously-written corpus at `path` (if any) so re-running the
 * builder with the same `--out` and `--seed` reuses already-fetched cases
 * instead of refetching. Keyed by AniList id, the stable identity of the
 * sampled anime across runs.
 */
async function loadExistingCases(
  path: string,
  seed: number,
): Promise<Map<string, KitsuMatchingCorpusCase>> {
  const file = Bun.file(path);
  if (!(await file.exists())) return new Map();

  try {
    const parsed: unknown = JSON.parse(await file.text());
    if (typeof parsed !== "object" || parsed === null) return new Map();
    const record = parsed as Record<string, unknown>;
    if (record.seed !== seed || !Array.isArray(record.cases)) return new Map();

    const byAnilistId = new Map<string, KitsuMatchingCorpusCase>();
    for (const item of record.cases) {
      if (!isValidExistingCase(item)) continue;
      const anilistId = item.hints.anilistId;
      if (typeof anilistId === "string") byAnilistId.set(anilistId, item);
    }
    return byAnilistId;
  } catch {
    return new Map();
  }
}

async function fetchCandidatesForHints(hints: MatchHints): Promise<KitsuSearchNode[]> {
  const searchTitles = kitsuSearchTitles(hints);
  const byId = new Map<string, KitsuSearchNode>();

  for (const title of [...searchTitles.primary, ...searchTitles.fallback]) {
    const nodes = await searchKitsuByTitle(title);
    for (const node of nodes) {
      if (!byId.has(node.id)) byId.set(node.id, node);
    }
    await Bun.sleep(REQUEST_DELAY_MS);
  }

  return [...byId.values()];
}

async function buildCorpus(options: CorpusCommandOptions): Promise<KitsuMatchingCorpus> {
  const rows = await loadAuthoritativeRows();
  if (rows.length === 0) {
    throw new Error("No authoritative kitsu mappings (provider='kitsu', source='api') were found");
  }

  const sampledRows = stratifiedSample(rows, options.sampleSize, options.seed);
  const existingByAnilistId = await loadExistingCases(options.outPath, options.seed);

  const cases: KitsuMatchingCorpusCase[] = [];
  let fetchedCount = 0;
  let reusedCount = 0;

  for (let index = 0; index < sampledRows.length; index += 1) {
    const row = sampledRows[index]!;
    const existing = existingByAnilistId.get(row.anilistId);

    if (existing) {
      cases.push(existing);
      reusedCount += 1;
    } else {
      const hints = buildHints(row);
      const candidates = await fetchCandidatesForHints(hints);
      cases.push({ hints, expectedKitsuId: row.expectedKitsuId, candidates });
      fetchedCount += 1;
    }

    const processed = index + 1;
    if (processed % PROGRESS_INTERVAL === 0 || processed === sampledRows.length) {
      console.error(
        `Progress: ${processed}/${sampledRows.length} cases (${fetchedCount} fetched, ${reusedCount} reused)`,
      );
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    seed: options.seed,
    sampleSize: cases.length,
    cases,
  };
}

async function main(): Promise<void> {
  const options = parseCorpusCommandArgs(Bun.argv.slice(2));
  const corpus = await buildCorpus(options);

  await mkdir(dirname(options.outPath), { recursive: true });
  await Bun.write(options.outPath, `${JSON.stringify(corpus, null, 2)}\n`);
  console.error(`Wrote ${corpus.cases.length} cases to ${options.outPath}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await closeDb().catch(() => undefined);
  }
}
