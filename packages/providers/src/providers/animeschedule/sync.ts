import { and, eq, sql } from "drizzle-orm";

import { db } from "@anicore/db";
import { syncAnimeLanguageEvidenceFromEpisodeStatuses } from "@anicore/db/language-status";
import {
  animeMappings,
  episodeLanguageStatus,
  episodes,
} from "@anicore/db/schema";
import { titleSimilarity } from "../title-similarity";
import {
  assertAnimeScheduleRouteCompatible,
  assertSingleAnimeScheduleIdentity,
} from "./identity";
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

export type AnimeScheduleDubEvidenceAction = "available" | "missing" | "clear";

const RATE_MS = 250;
export const sleep = (ms: number) => Bun.sleep(ms);

export function isAnimeScheduleEntryForAnilist(
  entry: AnimeScheduleEntry | null,
  anilistId: string,
): boolean {
  return Boolean(
    entry?.websites && parseAnilistId(entry.websites.aniList) === anilistId,
  );
}

export function animeScheduleDubEvidenceAction(
  entry: AnimeScheduleEntry,
): AnimeScheduleDubEvidenceAction {
  if (!hasDub(entry)) return "missing";
  return isFinished(entry) ? "available" : "clear";
}

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
    if (entry && isAnimeScheduleEntryForAnilist(entry, opts.anilistId)) {
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
      if (full && isAnimeScheduleEntryForAnilist(full, opts.anilistId)) {
        return full;
      }
    }
  }

  return null;
}

async function loadAnimeScheduleIdentities(animeId: number) {
  return db
    .select({
      providerId: animeMappings.providerId,
      source: animeMappings.source,
      confidence: animeMappings.confidence,
    })
    .from(animeMappings)
    .where(
      and(
        eq(animeMappings.animeId, animeId),
        eq(animeMappings.provider, "animeschedule"),
      ),
    );
}

async function storeRoute(animeId: number, route: string): Promise<void> {
  const existingForAnime = await loadAnimeScheduleIdentities(animeId);
  assertAnimeScheduleRouteCompatible(existingForAnime, route);

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
  const mappings = await db
    .select({
      id: animeMappings.id,
      providerId: animeMappings.providerId,
      source: animeMappings.source,
      confidence: animeMappings.confidence,
    })
    .from(animeMappings)
    .where(
      and(
        eq(animeMappings.animeId, opts.animeId),
        eq(animeMappings.provider, "animeschedule"),
      ),
    );

  const identity = assertSingleAnimeScheduleIdentity(mappings);
  if (!identity) return null;
  const existing = mappings[0]!;

  await sleep(RATE_MS);
  const entry = await fetchByRoute(existing.providerId);
  if (entry && isAnimeScheduleEntryForAnilist(entry, opts.anilistId)) {
    return entry;
  }

  if (["manual", "import", "system"].includes(existing.source)) {
    throw new Error(
      `Stored AnimeSchedule mapping ${existing.providerId} does not verify against AniList ${opts.anilistId}; refusing to override ${existing.source} mapping`,
    );
  }

  await db.delete(animeMappings).where(eq(animeMappings.id, existing.id));
  return null;
}

function animeScheduleEvidenceSourceUrl(route: string): string {
  return `https://animeschedule.net/anime/${route}`;
}

async function clearDubStatus(
  animeId: number,
  sourceUrl: string,
): Promise<void> {
  await db
    .delete(episodeLanguageStatus)
    .where(
      and(
        eq(episodeLanguageStatus.animeId, animeId),
        eq(episodeLanguageStatus.languageCode, "en"),
        eq(episodeLanguageStatus.mediaType, "audio"),
        eq(episodeLanguageStatus.provider, "animeschedule"),
      ),
    );

  await syncAnimeLanguageEvidenceFromEpisodeStatuses({
    animeId,
    languageCode: "en",
    mediaType: "audio",
    provider: "animeschedule",
    sourceUrl,
  });
}

async function upsertDubStatus(
  animeId: number,
  dubStatus: "available" | "missing",
  sourceUrl: string,
): Promise<number> {
  const rows = await db
    .select({ number: episodes.number })
    .from(episodes)
    .where(eq(episodes.animeId, animeId));

  if (!rows.length) {
    await clearDubStatus(animeId, sourceUrl);
    return 0;
  }

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

  if (!isAnimeScheduleEntryForAnilist(entry, opts.anilistId)) {
    throw new Error(
      `AnimeSchedule route ${entry.route} does not match AniList ${opts.anilistId}`,
    );
  }

  const sourceUrl = animeScheduleEvidenceSourceUrl(entry.route);
  const evidenceAction = animeScheduleDubEvidenceAction(entry);

  if (evidenceAction === "missing") {
    const count = await upsertDubStatus(opts.animeId, "missing", sourceUrl);
    return {
      status: "matched-no-dub",
      route: entry.route,
      episodesMarked: count,
    };
  }

  if (evidenceAction === "available") {
    const count = await upsertDubStatus(opts.animeId, "available", sourceUrl);
    if (!count) return { status: "no-episodes" };
    return {
      status: "matched-fully-dubbed",
      route: entry.route,
      episodesMarked: count,
    };
  }

  await clearDubStatus(opts.animeId, sourceUrl);
  return { status: "matched-ongoing-dub", route: entry.route, episodesMarked: 0 };
}
