import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@anicore/db";
import { syncAnimeLanguageEvidenceFromEpisodeStatuses } from "@anicore/db/language-status";
import {
  anime,
  animeMappings,
  episodeLanguageStatus,
  episodes,
} from "@anicore/db/schema";
import {
  fetchByRoute,
  hasDub,
  isFinished,
  parseAnilistId,
  searchByTitle,
  type AnimeScheduleEntry,
} from "./client";

export type DubSyncStatus =
  | "matched-fully-dubbed"
  | "matched-no-dub"
  | "matched-ongoing-dub"
  | "unmatched"
  | "no-episodes";

export interface DubSyncResult {
  status: DubSyncStatus;
  route?: string;
  episodesMarked?: number;
}

// Rate limit: 250 ms between requests (conservative for public API)
const RATE_MS = 250;
export const sleep = (ms: number) => Bun.sleep(ms);

// Word-overlap title similarity in [0, 1]
function titleSimilarity(a: string, b: string): number {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  const aWords = norm(a).split(/\s+/).filter(Boolean);
  const bWords = new Set(norm(b).split(/\s+/).filter(Boolean));
  if (!aWords.length || !bWords.size) return 0;
  return aWords.filter((w) => bWords.has(w)).length /
    Math.max(aWords.length, bWords.size);
}

// Attempt to find the anime-schedule.net entry for an anime.
// Fast path: slug matches their route and AniList ID confirms it.
// Slow path: title search → fetch top matches → verify via AniList ID.
async function findEntry(opts: {
  anilistId: string;
  slug: string | null;
  titleRomaji: string;
  titleEnglish: string | null;
}): Promise<AnimeScheduleEntry | null> {
  // Fast path: direct slug lookup
  if (opts.slug) {
    await sleep(RATE_MS);
    const entry = await fetchByRoute(opts.slug);
    if (entry?.websites) {
      if (parseAnilistId(entry.websites.aniList) === opts.anilistId) {
        return entry;
      }
    }
  }

  // Slow path: search by title, verify each result's AniList ID
  const searchTitles = [opts.titleRomaji];
  if (opts.titleEnglish && opts.titleEnglish !== opts.titleRomaji) {
    searchTitles.push(opts.titleEnglish);
  }

  for (const title of searchTitles) {
    await sleep(RATE_MS);
    const results = await searchByTitle(title);
    if (!results.length) continue;

    // Sort by title similarity, take top 3 to verify
    const ranked = results
      .map((r) => ({ r, score: titleSimilarity(r.title, title) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    for (const { r } of ranked) {
      await sleep(RATE_MS);
      const full = await fetchByRoute(r.route);
      if (!full?.websites) continue;
      if (parseAnilistId(full.websites.aniList) === opts.anilistId) {
        return full;
      }
    }

    // Found search results but none verified — don't bother with English title
    if (results.length > 0) break;
  }

  return null;
}

// Store the animeschedule route in animeMappings so future runs skip the search
async function storeRoute(animeId: number, route: string): Promise<void> {
  await db
    .insert(animeMappings)
    .values({
      animeId,
      provider: "animeschedule",
      providerId: route,
      providerSlug: route,
      providerUrl: `https://animeschedule.net/anime/${route}`,
      confidence: 95,
      source: "api",
      isPrimary: false,
    })
    .onConflictDoNothing();
}

// Upsert dub status rows for every episode of an anime in 500-row chunks.
async function upsertDubStatus(
  animeId: number,
  dubStatus: "available" | "missing",
  sourceUrl: string,
): Promise<number> {
  const rows = await db
    .select({ number: episodes.number })
    .from(episodes)
    .where(eq(episodes.animeId, animeId));

  if (!rows.length) return 0;

  const checkedAt = new Date();
  const CHUNK = 500;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await db
      .insert(episodeLanguageStatus)
      .values(
        chunk.map((ep) => ({
          animeId,
          episodeNumber: ep.number,
          languageCode: "en",
          mediaType: "audio" as const,
          status: dubStatus,
          provider: "animeschedule",
          confidence: 90,
          checkedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [
          episodeLanguageStatus.animeId,
          episodeLanguageStatus.episodeNumber,
          episodeLanguageStatus.languageCode,
          episodeLanguageStatus.mediaType,
          episodeLanguageStatus.provider,
        ],
        set: {
          status: sql`excluded.status`,
          confidence: sql`excluded.confidence`,
          checkedAt: sql`excluded.checked_at`,
          updatedAt: sql`now()`,
        },
      });
  }

  await syncAnimeLanguageEvidenceFromEpisodeStatuses({
    animeId,
    languageCode: "en",
    mediaType: "audio",
    provider: "animeschedule",
    sourceUrl,
  });

  return rows.length;
}

export async function syncDubStatus(opts: {
  animeId: number;
  anilistId: string;
  slug: string | null;
  titleRomaji: string;
  titleEnglish: string | null;
}): Promise<DubSyncResult> {
  // Check if we already have a cached animeschedule route
  const [existing] = await db
    .select({ providerId: animeMappings.providerId })
    .from(animeMappings)
    .where(
      and(
        eq(animeMappings.animeId, opts.animeId),
        eq(animeMappings.provider, "animeschedule"),
      ),
    )
    .limit(1);

  let entry: AnimeScheduleEntry | null = null;

  if (existing) {
    await sleep(RATE_MS);
    entry = await fetchByRoute(existing.providerId);
  } else {
    entry = await findEntry(opts);
    if (entry) await storeRoute(opts.animeId, entry.route);
  }

  if (!entry) return { status: "unmatched" };

  const dubbed = hasDub(entry);
  const finished = isFinished(entry);

  if (!dubbed) {
    // anime-schedule.net has incomplete dub coverage for older shows — absence
    // of their dub data doesn't mean no dub exists, so we don't write "unavailable".
    return { status: "matched-no-dub", route: entry.route, episodesMarked: 0 };
  }

  if (finished) {
    const count = await upsertDubStatus(
      opts.animeId,
      "available",
      `https://animeschedule.net/anime/${entry.route}`,
    );
    if (!count) return { status: "no-episodes" };
    return {
      status: "matched-fully-dubbed",
      route: entry.route,
      episodesMarked: count,
    };
  }

  // Ongoing with a dub — we know it exists but can't count episodes without
  // an API token (timetable endpoint requires auth). Leave as "unknown".
  return { status: "matched-ongoing-dub", route: entry.route, episodesMarked: 0 };
}
