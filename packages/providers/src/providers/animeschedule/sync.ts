import { db } from "@anicore/db";
import {
  type ProviderLanguageAssertion,
  replaceProviderLanguageSnapshot,
} from "@anicore/db/language-status";
import { animeMappings, episodes } from "@anicore/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { log } from "../../lib/logger";
import { waitForProvider } from "../../lib/provider-wait";
import { syncAuthoritativeCrossMappings } from "../authoritative-cross-mappings";
import { titleSimilarity } from "../title-similarity";
import type { ProviderAuthoritativeMapping } from "../types";
import {
  type AnimeScheduleEntry,
  fetchByRoute,
  hasLanguageTrack,
  parseAnilistId,
  parseKitsuReference,
  parseMalId,
  searchByAnilistId,
  searchByTitle,
  validScheduleDate,
} from "./client";
import { assertAnimeScheduleRouteCompatible, assertSingleAnimeScheduleIdentity } from "./identity";

export type DubSyncStatus =
  | "matched-fully-dubbed"
  | "matched-unknown"
  | "matched-ongoing-dub"
  | "matched-dub"
  | "unmatched";
export interface DubSyncResult {
  status: DubSyncStatus;
  route?: string;
  episodesMarked?: number;
  subtitlesMarked?: number;
}

export const sleep = (ms: number) => waitForProvider(ms);
const RATE_MS = 250;
const SOURCE_PREFIX = "https://animeschedule.net/anime/";

export function isAnimeScheduleEntryForAnilist(
  entry: AnimeScheduleEntry | null,
  anilistId: string,
): boolean {
  return Boolean(entry?.websites && parseAnilistId(entry.websites.aniList) === anilistId);
}

export function animeScheduleCrossMappings(entry: AnimeScheduleEntry): {
  mappings: ProviderAuthoritativeMapping[];
  skippedKitsuSlug: string | null;
} {
  const mappings: ProviderAuthoritativeMapping[] = [];
  const malId = parseMalId(entry.websites?.mal);
  if (malId)
    mappings.push({
      provider: "mal",
      providerId: malId,
      providerUrl: `https://myanimelist.net/anime/${malId}`,
    });
  const { kitsuId, kitsuSlug } = parseKitsuReference(entry.websites?.kitsu);
  if (kitsuId)
    mappings.push({
      provider: "kitsu",
      providerId: kitsuId,
      providerSlug: kitsuSlug,
      providerUrl: `https://kitsu.io/anime/${kitsuId}`,
    });
  return { mappings, skippedKitsuSlug: kitsuId ? null : kitsuSlug };
}

export interface ScheduleTrackEvidence {
  exists: boolean;
  availableEpisodes: number[];
}

/** Only explicit, already-aired episode numbers establish episode coverage. */
export function animeScheduleTrackEvidence(
  entry: AnimeScheduleEntry,
  mediaType: "audio" | "subtitle",
  now = Date.now(),
): ScheduleTrackEvidence {
  const premiere = validScheduleDate(mediaType === "audio" ? entry.dubPremier : entry.subPremier);
  const override = mediaType === "audio" ? entry.dubEpisodeOverride : entry.subEpisodeOverride;
  const overrideDate = validScheduleDate(override?.overrideDate);
  const available = new Set<number>();
  if (premiere !== null && premiere <= now) available.add(1);
  if (
    overrideDate !== null &&
    overrideDate <= now &&
    Number.isInteger(override?.overrideEpisode) &&
    override.overrideEpisode > 0 &&
    Number.isInteger(override.episodesAired) &&
    override.episodesAired >= 0 &&
    override.episodesAired < override.overrideEpisode &&
    override.overrideEpisode <= 10000
  ) {
    // episodesAired describes this batch, NOT the total number released.
    for (
      let number = override.overrideEpisode - override.episodesAired;
      number <= override.overrideEpisode;
      number++
    )
      available.add(number);
  }
  const exists =
    available.size > 0 ||
    (premiere === null &&
      hasLanguageTrack(entry, mediaType) &&
      (validScheduleDate(entry.premier) ?? Infinity) <= now);
  return { exists, availableEpisodes: [...available].sort((a, b) => a - b) };
}

export type AnimeScheduleDubEvidenceAction = "available" | "clear";
export function animeScheduleDubEvidenceAction(
  entry: AnimeScheduleEntry,
): AnimeScheduleDubEvidenceAction {
  return animeScheduleTrackEvidence(entry, "audio").exists ? "available" : "clear";
}

export function selectVerifiedAnimeScheduleEntry(
  entries: AnimeScheduleEntry[],
  anilistId: string,
): AnimeScheduleEntry | null {
  const matches = new Map(
    entries
      .filter((entry) => isAnimeScheduleEntryForAnilist(entry, anilistId))
      .map((entry) => [entry.route, entry]),
  );
  if (matches.size > 1)
    throw new Error(
      `Multiple AnimeSchedule routes claim AniList ${anilistId}: ${[...matches.keys()].join(", ")}`,
    );
  return [...matches.values()][0] ?? null;
}

interface SyncOptions {
  animeId: number;
  anilistId: string;
  slug: string | null;
  titleRomaji: string;
  titleEnglish: string | null;
}

async function findEntry(opts: SyncOptions): Promise<AnimeScheduleEntry | null> {
  // Published IDs avoid title, transliteration, and sequel search ambiguities.
  await sleep(RATE_MS);
  const direct = selectVerifiedAnimeScheduleEntry(
    await searchByAnilistId(opts.anilistId),
    opts.anilistId,
  );
  if (direct) return direct;
  const checkedRoutes = new Set<string>();
  if (opts.slug) {
    await sleep(RATE_MS);
    const entry = await fetchByRoute(opts.slug);
    checkedRoutes.add(opts.slug);
    if (isAnimeScheduleEntryForAnilist(entry, opts.anilistId)) return entry;
  }
  for (const title of new Set(
    [opts.titleRomaji, opts.titleEnglish].filter((title): title is string => Boolean(title)),
  )) {
    await sleep(RATE_MS);
    const results = await searchByTitle(title);
    const linked = selectVerifiedAnimeScheduleEntry(results, opts.anilistId);
    if (linked) return linked;
    const ranked = results.sort(
      (a, b) => titleSimilarity(b.title, title) - titleSimilarity(a.title, title),
    );
    for (const result of ranked) {
      if (checkedRoutes.has(result.route)) continue;
      checkedRoutes.add(result.route);
      await sleep(RATE_MS);
      const full = await fetchByRoute(result.route);
      if (isAnimeScheduleEntryForAnilist(full, opts.anilistId)) return full;
    }
  }
  return null;
}

async function storeRoute(animeId: number, route: string): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(animeMappings)
      .where(and(eq(animeMappings.animeId, animeId), eq(animeMappings.provider, "animeschedule")));
    assertAnimeScheduleRouteCompatible(existing, route);
    const [mapping] = await tx
      .insert(animeMappings)
      .values({
        animeId,
        provider: "animeschedule",
        providerId: route,
        providerSlug: route,
        providerUrl: `${SOURCE_PREFIX}${route}`,
        confidence: 100,
        source: "api",
        isPrimary: true,
      })
      .onConflictDoUpdate({
        target: [animeMappings.provider, animeMappings.providerId],
        set: {
          providerSlug: route,
          providerUrl: `${SOURCE_PREFIX}${route}`,
          confidence: 100,
          isPrimary: true,
          source: sql`case when ${animeMappings.source} in ('manual', 'import', 'system') then ${animeMappings.source} else 'api' end`,
          updatedAt: new Date(),
        },
        setWhere: eq(animeMappings.animeId, animeId),
      })
      .returning({ animeId: animeMappings.animeId });
    if (!mapping) throw new Error(`AnimeSchedule route ${route} already belongs to another anime`);
  });
}

async function clearSnapshot(animeId: number): Promise<void> {
  await replaceProviderLanguageSnapshot({
    animeId,
    provider: "animeschedule",
    sourceUrlPrefixes: [SOURCE_PREFIX, "urn:anicore:episode-language-status:animeschedule"],
    evidenceTypes: ["provider_audio", "provider_subtitle"],
    evidence: [],
  });
}

async function loadVerifiedCachedEntry(opts: SyncOptions): Promise<AnimeScheduleEntry | null> {
  const mappings = await db
    .select()
    .from(animeMappings)
    .where(
      and(eq(animeMappings.animeId, opts.animeId), eq(animeMappings.provider, "animeschedule")),
    );
  let identity: ReturnType<typeof assertSingleAnimeScheduleIdentity>;
  try {
    identity = assertSingleAnimeScheduleIdentity(mappings);
  } catch (error) {
    await clearSnapshot(opts.animeId);
    throw error;
  }
  if (!identity) return null;
  await sleep(RATE_MS);
  // Outages throw: never interpret a server failure as identity withdrawal.
  const entry = await fetchByRoute(identity.providerId);
  if (isAnimeScheduleEntryForAnilist(entry, opts.anilistId)) return entry;
  if (["manual", "import", "system"].includes(identity.source)) {
    await clearSnapshot(opts.animeId);
    throw new Error(
      `Stored AnimeSchedule mapping ${identity.providerId} does not verify against AniList ${opts.anilistId}; refusing to override ${identity.source} mapping`,
    );
  }
  // A disproved automatic identity cannot keep supplying language evidence.
  await clearSnapshot(opts.animeId);
  await db.delete(animeMappings).where(eq(animeMappings.id, mappings[0]!.id));
  return null;
}

async function persistCrossMappings(animeId: number, entry: AnimeScheduleEntry): Promise<void> {
  const { mappings, skippedKitsuSlug } = animeScheduleCrossMappings(entry);
  if (skippedKitsuSlug)
    log.warn(
      `AnimeSchedule ${entry.route} references Kitsu by slug (${skippedKitsuSlug}); no numeric id to store`,
    );
  if (!mappings.length) return;
  try {
    await syncAuthoritativeCrossMappings(animeId, mappings);
  } catch (err) {
    log.warn(
      `AnimeSchedule cross-mapping for anime ${animeId} (${entry.route}) rejected: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Refreshes BOTH English audio and subtitles from the same verified identity. */
export async function syncDubStatus(opts: SyncOptions): Promise<DubSyncResult> {
  const entry = (await loadVerifiedCachedEntry(opts)) ?? (await findEntry(opts));
  if (!entry) {
    await clearSnapshot(opts.animeId);
    return { status: "unmatched" };
  }
  if (!isAnimeScheduleEntryForAnilist(entry, opts.anilistId))
    throw new Error(`AnimeSchedule route ${entry.route} does not match AniList ${opts.anilistId}`);
  // An explicit sibling MAL conflict invalidates this identity for language evidence too.
  const mal = await db
    .select()
    .from(animeMappings)
    .where(and(eq(animeMappings.animeId, opts.animeId), eq(animeMappings.provider, "mal")));
  const publishedMal = parseMalId(entry.websites?.mal);
  if (
    publishedMal &&
    mal.some((mapping) => mapping.providerId !== publishedMal && mapping.source !== "fuzzy")
  ) {
    await clearSnapshot(opts.animeId);
    throw new Error(`AnimeSchedule ${entry.route} conflicts with the stored MAL identity`);
  }
  await storeRoute(opts.animeId, entry.route);
  await persistCrossMappings(opts.animeId, entry);
  const rows = await db
    .select({ number: episodes.number, kind: episodes.kind })
    .from(episodes)
    .where(eq(episodes.animeId, opts.animeId))
    .orderBy(asc(episodes.number));
  const evidence: ProviderLanguageAssertion[] = [];
  const episodeRows: NonNullable<
    Parameters<typeof replaceProviderLanguageSnapshot>[0]["episodes"]
  > = [];
  const tracks = {
    audio: animeScheduleTrackEvidence(entry, "audio"),
    subtitle: animeScheduleTrackEvidence(entry, "subtitle"),
  };
  let completeDub = false;
  for (const mediaType of ["audio", "subtitle"] as const) {
    const track = tracks[mediaType];
    if (!track.exists) continue;
    // A numbering/count conflict permits anime-level existence, never per-episode guesses.
    const compatible =
      Number.isInteger(entry.episodes) &&
      entry.episodes! > 0 &&
      rows.length === entry.episodes &&
      rows.every((row, index) => row.kind === "normal" && row.number === index + 1);
    const numbers = compatible
      ? new Set(track.availableEpisodes.filter((number) => number <= entry.episodes!))
      : new Set<number>();
    const complete = compatible && numbers.size === entry.episodes;
    if (mediaType === "audio") completeDub = complete;
    const value = numbers.size > 0 && !complete ? "partial" : "available";
    evidence.push({
      languageCode: "en",
      mediaType,
      evidenceType: mediaType === "audio" ? "provider_audio" : "provider_subtitle",
      sourceUrl: `${SOURCE_PREFIX}${entry.route}`,
      value,
      confidence: 90,
    });
    for (const episodeNumber of numbers)
      episodeRows.push({
        episodeNumber,
        languageCode: "en",
        mediaType,
        status: "available",
        confidence: 90,
      });
  }
  await replaceProviderLanguageSnapshot({
    animeId: opts.animeId,
    provider: "animeschedule",
    sourceUrlPrefixes: [SOURCE_PREFIX, "urn:anicore:episode-language-status:animeschedule"],
    evidenceTypes: ["provider_audio", "provider_subtitle"],
    evidence,
    episodes: episodeRows,
  });
  return {
    status: completeDub
      ? "matched-fully-dubbed"
      : tracks.audio.exists
        ? tracks.audio.availableEpisodes.length
          ? "matched-ongoing-dub"
          : "matched-dub"
        : "matched-unknown",
    route: entry.route,
    episodesMarked: episodeRows.filter((row) => row.mediaType === "audio").length,
    subtitlesMarked: episodeRows.filter((row) => row.mediaType === "subtitle").length,
  };
}
