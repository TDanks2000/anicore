import { and, eq, sql } from "drizzle-orm";

import { db } from "@anicore/db";
import { syncAnimeLanguageEvidenceFromEpisodeStatuses } from "@anicore/db/language-status";
import {
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

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(a: string, b: string): number {
  const aWords = normalizeTitle(a).split(/\s+/).filter(Boolean);
  const bWords = new Set(normalizeTitle(b).split(/\s+/).filter(Boolean));
  if (!aWords.length || !bWords.size) return 0;
  return (
    aWords.filter((word) => bWords.has(word)).length /
    Math.max(aWords.length, bWords.size)
  );
}

export function isAnimeScheduleEntryForAnilist(
  entry: AnimeScheduleEntry | null,
  anilistId: string,
): entry is AnimeScheduleEntry {
  return Boolean(
    entry?.websites && parseAnilistId(entry.websites.aniList) === anilistId,
  );
}

// Attempt to find the anime-schedule.net entry for an anime. Every accepted
// route is verified using AnimeSchedule's AniList website link; title scoring is
// only used to decide which search results to verify first.
async function findEntry(opts: {
  anilistId: string;
  slug: string | null;
  titleRomaji: string;
  titleEnglish: string | null;
}): Promise<AnimeScheduleEntry | null> {
  const checkedRoutes = new Set<string>();

  if (opts.slug) {
    await sleep(RATE_MS);
    const entry = await fetchByRoute(opts.slug);
    checkedRoutes.add(opts.slug);
    if (isAnimeScheduleEntryForAnilist(entry, opts.anilistId)) {
      return entry;
    }
  }

  const searchTitles = [opts.titleRomaji];
  if (opts.titleEnglish && opts.titleEnglish !== opts.titleRomaji) {
    searchTitles.push(opts.titleEnglish);
  }

  for (const title of searchTitles) {
    await sleep(RATE_MS);
    const results = await searchByTitle(title);
    if (!results.length) continue;

    const ranked = results
      .map((result) => ({
        result,
        score: titleSimilarity(result.title, title),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    for (const { result } of ranked) {
      if (checkedRoutes.has(result.route)) continue;
      checkedRoutes.add(result.route);

      await sleep(RATE_MS);
      const full = await fetchByRoute(result.route);
      if (isAnimeScheduleEntryForAnilist(full, opts.anilistId)) {
        return full;
      }
    }

    // Do not stop just because the Romaji search returned unverified results.
    // The English title can rank the same verified entry very differently.
  }

  return null;
}

async function storeRoute(animeId: number, route: string): Promise<void> {
  const [mapping] = await db
    .insert(animeMappings)
    .values({
      animeId,
      provider: "animeschedule",
      providerId: route,
      providerSlug: route,
      providerUrl: `https://animeschedule.net/anime/${route}`,
      confidence: 100,
      source: "api",
      isPrimary: false,
    })
    .onConflictDoUpdate({
      target: [animeMappings.provider, animeMappings.providerId],
      set: {
        providerSlug: route,
        providerUrl: `https://animeschedule.net/anime/${route}`,
        confidence: sql`greatest(${animeMappings.confidence}, 100)`,
        source: sql`case
          when ${animeMappings.source} in ('manual', 'import', 'system')
            then ${animeMappings.source}
          else 'api'
        end`,
        isPrimary: animeMappings.isPrimary,
        updatedAt: sql`now()`,
      },
      setWhere: eq(animeMappings.animeId, animeId),
    })
    .returning({ animeId: animeMappings.animeId });

  if (!mapping) {
    throw new Error(
      `AnimeSchedule route ${route} already belongs to another anime`,
    );
  }
}

async function loadVerifiedCachedEntry(opts: {
  animeId: number;
  anilistId: string;
}): Promise<AnimeScheduleEntry | null> {
  const [existing] = await db
    .select({
      id: animeMappings.id,
      providerId: animeMappings.providerId,
      source: animeMappings.source,
    })
    .from(animeMappings)
    .where(
      and(
        eq(animeMappings.animeId, opts.animeId),
        eq(animeMappings.provider, "animeschedule"),
      ),
    )
    .limit(1);

  if (!existing) return null;

  await sleep(RATE_MS);
  const entry = await fetchByRoute(existing.providerId);
  if (isAnimeScheduleEntryForAnilist(entry, opts.anilistId)) {
    return entry;
  }

  if (["manual", "import", "system"].includes(existing.source)) {
    throw new Error(
      `Stored AnimeSchedule mapping ${existing.providerId} does not verify against AniList ${opts.anilistId}; refusing to override ${existing.source} mapping`,
    );
  }

  // Automatically-created cached mappings are safe to discard when the
  // provider no longer verifies them. This prevents a stale route from being
  // trusted forever and lets the verified search path repair it immediately.
  await db.delete(animeMappings).where(eq(animeMappings.id, existing.id));
  return null;
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
        chunk.map((episode) => ({
          animeId,
          episodeNumber: episode.number,
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
  let entry = await loadVerifiedCachedEntry({
    animeId: opts.animeId,
    anilistId: opts.anilistId,
  });

  if (!entry) {
    entry = await findEntry(opts);
    if (entry) {
      await storeRoute(opts.animeId, entry.route);
    }
  }

  if (!entry) return { status: "unmatched" };

  // This invariant is intentionally checked again immediately before evidence
  // is written, so future refactors cannot accidentally bypass verification.
  if (!isAnimeScheduleEntryForAnilist(entry, opts.anilistId)) {
    throw new Error(
      `AnimeSchedule route ${entry.route} does not match AniList ${opts.anilistId}`,
    );
  }

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
