import { db } from "@anicore/db";
import {
  type ProviderLanguageAssertion,
  replaceProviderLanguageSnapshot,
} from "@anicore/db/language-status";
import {
  animeProviderMappings,
  animeProviderSegments,
  providerEntities,
} from "@anicore/db/provider-mapping-schema";
import { anime, animeExternalLinks, episodeMappings, episodes } from "@anicore/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { log } from "../../lib/logger";
import {
  type AlignmentTarget,
  alignCrunchyroll,
  type CrunchyrollAlignment,
  type CrunchyrollCatalogue,
  crunchyrollLanguage,
  isMainEpisode,
  isPlaceholderTitle,
  parseCrunchyrollLink,
  sameTitle,
  seasonBySiblingOrder,
  seasonPlausiblyThisAnime,
} from "./alignment";
import {
  type CrunchyrollEpisode,
  type CrunchyrollSeries,
  fetchEpisodes,
  fetchSeasons,
  fetchSeries,
  searchSeries,
} from "./client";

const PROVIDER = "crunchyroll";
const SOURCE_PREFIX = "https://www.crunchyroll.com/";
const SNAPSHOT_URN = "urn:anicore:episode-language-status:crunchyroll";
const CATALOGUE_TTL_MS = 30 * 60_000;
const CATALOGUE_CACHE_LIMIT = 64;

export interface CrunchyrollSyncResult {
  status: "matched" | "series-only" | "unmatched";
  seriesId?: string;
  tier?: CrunchyrollAlignment["tier"];
  episodes?: number;
  reason?: string;
}

export interface CrunchyrollApi {
  fetchSeries: typeof fetchSeries;
  fetchSeasons: typeof fetchSeasons;
  fetchEpisodes: typeof fetchEpisodes;
  searchSeries: typeof searchSeries;
}

const liveApi: CrunchyrollApi = { fetchSeries, fetchSeasons, fetchEpisodes, searchSeries };

// Sequels of one show share a series, so a sync run would otherwise refetch
// the same seasons once per AniList entry.
const catalogueCache = new Map<string, { at: number; value: CrunchyrollCatalogue | null }>();

export function clearCrunchyrollCatalogueCache(): void {
  catalogueCache.clear();
}

async function loadCatalogue(
  api: CrunchyrollApi,
  seriesId: string,
): Promise<CrunchyrollCatalogue | null> {
  const cached = catalogueCache.get(seriesId);
  if (cached && Date.now() - cached.at < CATALOGUE_TTL_MS) return cached.value;
  const series = await api.fetchSeries(seriesId);
  let value: CrunchyrollCatalogue | null = null;
  if (series) {
    const seasons = await api.fetchSeasons(series.id);
    value = { series, seasons: [] };
    for (const season of seasons) {
      if (season.seriesId !== series.id)
        throw new Error("Crunchyroll season belongs to another series");
      if (!season.isOriginal) continue;
      value.seasons.push({ season, episodes: await api.fetchEpisodes(season.id) });
    }
  }
  catalogueCache.set(seriesId, { at: Date.now(), value });
  if (catalogueCache.size > CATALOGUE_CACHE_LIMIT)
    catalogueCache.delete(catalogueCache.keys().next().value!);
  return value;
}

function seriesUrl(series: CrunchyrollSeries): string {
  return `${SOURCE_PREFIX}series/${series.id}/${series.slugTitle}`;
}

interface AnimeContext {
  id: number;
  format: string | null;
  titles: string[];
  target: AlignmentTarget;
  links: string[];
  episodeRows: Array<{
    id: number;
    number: number;
    title: string | null;
    titleEnglish: string | null;
    lengthMinutes: number | null;
  }>;
}

async function loadContext(animeId: number): Promise<AnimeContext> {
  const [row] = await db.select().from(anime).where(eq(anime.id, animeId)).limit(1);
  if (!row) throw new Error(`Anime ${animeId} not found`);
  const links = await db
    .select({ url: animeExternalLinks.url })
    .from(animeExternalLinks)
    .where(eq(animeExternalLinks.animeId, animeId));
  const episodeRows = await db
    .select({
      id: episodes.id,
      number: episodes.number,
      title: episodes.title,
      titleEnglish: episodes.titleEnglish,
      titleRomaji: episodes.titleRomaji,
      lengthMinutes: episodes.lengthMinutes,
    })
    .from(episodes)
    .where(and(eq(episodes.animeId, animeId), eq(episodes.kind, "normal")));
  let synonyms: string[] = [];
  try {
    const parsed = JSON.parse(row.synonymsJson) as unknown;
    if (Array.isArray(parsed)) synonyms = parsed.filter((item) => typeof item === "string");
  } catch {
    /* Malformed synonyms only reduce the titles available for search. */
  }
  const titles = [
    ...new Set(
      [row.titleEnglish, row.titleRomaji, row.titleUserPreferred, ...synonyms].filter(
        (title): title is string => Boolean(title?.trim()),
      ),
    ),
  ];
  return {
    id: row.id,
    format: row.format,
    titles,
    links: links.map((link) => link.url),
    episodeRows,
    target: {
      status: row.status,
      episodeCount: row.episodeCount,
      startDate: row.startDate,
      episodes: episodeRows.map((episode) => ({
        number: episode.number,
        titles: [episode.titleEnglish, episode.title, episode.titleRomaji].filter(
          (title): title is string => Boolean(title),
        ),
      })),
    },
  };
}

/** Series ids named by the anime's own catalogue links; legacy slugs are resolved by search. */
async function linkedSeriesIds(api: CrunchyrollApi, context: AnimeContext): Promise<string[]> {
  const ids = new Set<string>();
  const slugs = new Set<string>();
  for (const url of context.links) {
    const link = parseCrunchyrollLink(url);
    if (!link) continue;
    if ("seriesId" in link) ids.add(link.seriesId);
    else slugs.add(link.slug);
  }
  for (const slug of slugs) {
    const queries = new Set([...context.titles.slice(0, 2), slug.replaceAll("-", " ")]);
    for (const query of queries) {
      const match = (await api.searchSeries(query)).find((series) => series.slugTitle === slug);
      if (match) {
        ids.add(match.id);
        break;
      }
    }
  }
  return [...ids];
}

/** Without a published link, only an exactly titled series anchored on the premiere date is trusted. */
async function searchedSeriesIds(api: CrunchyrollApi, context: AnimeContext): Promise<string[]> {
  const ids = new Set<string>();
  const startYear = context.target.startDate ? Number(context.target.startDate.slice(0, 4)) : null;
  for (const query of context.titles.slice(0, 2)) {
    for (const series of await api.searchSeries(query)) {
      // A series cannot launch after its own first episode aired: a same-named
      // remake (Berserk 2016 for the 1997 series) is skipped without a fetch.
      if (startYear && series.launchYear && series.launchYear > startYear + 1) continue;
      if (context.titles.some((title) => sameTitle(title, series.title))) ids.add(series.id);
    }
  }
  return [...ids].slice(0, 3);
}

/** Anime publishing any of this anime's Crunchyroll links, itself included. */
async function linkedSiblings(context: AnimeContext) {
  const urls = context.links.filter((url) => parseCrunchyrollLink(url));
  if (!urls.length) return [];
  return db
    .selectDistinct({
      animeId: anime.id,
      episodeCount: anime.episodeCount,
      startDate: anime.startDate,
    })
    .from(animeExternalLinks)
    .innerJoin(anime, eq(animeExternalLinks.animeId, anime.id))
    .where(inArray(animeExternalLinks.url, urls));
}

async function alignBySiblingOrder(
  context: AnimeContext,
  catalogue: CrunchyrollCatalogue,
): Promise<CrunchyrollAlignment | null> {
  const season = seasonBySiblingOrder(catalogue, await linkedSiblings(context), context.id);
  if (!season) return null;
  const result = alignCrunchyroll(season, context.target);
  return result.ok ? result.alignment : null;
}

interface Resolution {
  catalogue: CrunchyrollCatalogue;
  alignment: CrunchyrollAlignment | null;
  authoritative: boolean;
}

async function resolve(
  api: CrunchyrollApi,
  context: AnimeContext,
): Promise<{ resolution: Resolution | null; reason: string }> {
  const linked = await linkedSeriesIds(api, context);
  const authoritative = linked.length > 0;
  const seriesIds = authoritative ? linked : await searchedSeriesIds(api, context);
  if (!seriesIds.length)
    return { resolution: null, reason: authoritative ? "linked series not found" : "no link" };

  const aligned: Resolution[] = [];
  const unaligned: CrunchyrollCatalogue[] = [];
  const reasons: string[] = [];
  for (const seriesId of seriesIds) {
    const catalogue = await loadCatalogue(api, seriesId);
    if (!catalogue) continue;
    const result = alignCrunchyroll(catalogue, context.target, {
      requireDateAnchor: !authoritative,
    });
    const tieBroken =
      !result.ok && authoritative ? await alignBySiblingOrder(context, catalogue) : null;
    if (result.ok) aligned.push({ catalogue, alignment: result.alignment, authoritative });
    else if (tieBroken) aligned.push({ catalogue, alignment: tieBroken, authoritative });
    else {
      unaligned.push(catalogue);
      reasons.push(`${seriesId}: ${result.reason}`);
    }
  }
  if (aligned.length === 1) return { resolution: aligned[0]!, reason: "aligned" };
  if (aligned.length > 1)
    return { resolution: null, reason: "several Crunchyroll series align with this anime" };
  // A published link to a series whose single season is plausibly this anime
  // identifies it even when episodes cannot be aligned one by one, so its
  // tracks apply to the anime as a whole without any per-episode claims.
  const [only] = unaligned;
  if (
    authoritative &&
    seriesIds.length === 1 &&
    only &&
    seasonPlausiblyThisAnime(only, { ...context.target, format: context.format })
  )
    return {
      resolution: { catalogue: only, alignment: null, authoritative },
      reason: reasons.join("; "),
    };
  return { resolution: null, reason: reasons.join("; ") || "linked series not found" };
}

function episodeLanguages(episode: CrunchyrollEpisode) {
  const audio = new Set(episode.audioLocales.map(crunchyrollLanguage).filter(Boolean) as string[]);
  const subtitle = new Set(
    episode.subtitleLocales.map(crunchyrollLanguage).filter(Boolean) as string[],
  );
  return { audio, subtitle };
}

async function clearSnapshot(animeId: number): Promise<void> {
  await replaceProviderLanguageSnapshot({
    animeId,
    provider: PROVIDER,
    sourceUrlPrefixes: [SOURCE_PREFIX, SNAPSHOT_URN],
    evidenceTypes: ["provider_audio", "provider_subtitle"],
    evidence: [],
  });
}

async function clearMappings(animeId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const stale = await tx
      .select({ id: animeProviderMappings.id })
      .from(animeProviderMappings)
      .innerJoin(providerEntities, eq(animeProviderMappings.providerEntityId, providerEntities.id))
      .where(
        and(eq(animeProviderMappings.animeId, animeId), eq(providerEntities.provider, PROVIDER)),
      );
    if (stale.length)
      await tx.delete(animeProviderMappings).where(
        inArray(
          animeProviderMappings.id,
          stale.map((row) => row.id),
        ),
      );
    const ids = (
      await tx.select({ id: episodes.id }).from(episodes).where(eq(episodes.animeId, animeId))
    ).map((row) => row.id);
    for (let offset = 0; offset < ids.length; offset += 500)
      await tx
        .delete(episodeMappings)
        .where(
          and(
            eq(episodeMappings.provider, PROVIDER),
            inArray(episodeMappings.episodeId, ids.slice(offset, offset + 500)),
          ),
        );
  });
}

async function persistMapping(
  context: AnimeContext,
  resolution: Resolution,
  aligned: Array<{ row: AnimeContext["episodeRows"][number]; episode: CrunchyrollEpisode }>,
): Promise<Set<number>> {
  const { catalogue, alignment, authoritative } = resolution;
  const entity =
    alignment?.entity ??
    ({ kind: "season", id: catalogue.seasons[0]!.season.id } as CrunchyrollAlignment["entity"]);
  const confidence = authoritative ? 100 : 90;
  const source = authoritative ? ("api" as const) : ("fuzzy" as const);
  const written = new Set<number>();
  await clearMappings(context.id);
  await db.transaction(async (tx) => {
    const [stored] = await tx
      .insert(providerEntities)
      .values({
        provider: PROVIDER,
        providerId: entity.id,
        providerSlug: catalogue.series.slugTitle,
        providerUrl: seriesUrl(catalogue.series),
      })
      .onConflictDoUpdate({
        target: [providerEntities.provider, providerEntities.providerId],
        set: {
          providerSlug: catalogue.series.slugTitle,
          providerUrl: seriesUrl(catalogue.series),
          updatedAt: new Date(),
        },
      })
      .returning({ id: providerEntities.id });
    const [mapping] = await tx
      .insert(animeProviderMappings)
      .values({
        animeId: context.id,
        providerEntityId: stored!.id,
        confidence,
        source,
        isPrimary: true,
      })
      .returning({ id: animeProviderMappings.id });
    if (alignment)
      await tx.insert(animeProviderSegments).values({
        animeProviderMappingId: mapping!.id,
        providerEpisodeStart: alignment.firstNumber,
        providerEpisodeEnd: alignment.firstNumber + alignment.length - 1,
        localEpisodeStart: 1,
        localEpisodeEnd: alignment.length,
      });
    for (const { row, episode } of aligned) {
      const [stored] = await tx
        .insert(episodeMappings)
        .values({
          episodeId: row.id,
          provider: PROVIDER,
          providerId: episode.id,
          providerUrl: `${SOURCE_PREFIX}watch/${episode.id}`,
          providerEpisodeNumber: episode.episode,
          confidence,
          source,
        })
        .onConflictDoNothing()
        .returning({ id: episodeMappings.id });
      // The Crunchyroll episode already belongs to another anime's alignment,
      // so one of the two is wrong: neither is overwritten or trusted here.
      if (!stored) continue;
      written.add(row.id);
      const minutes = episode.durationMs
        ? Math.max(1, Math.round(episode.durationMs / 60_000))
        : null;
      // Some back catalogue is titled only "Episode N"; that is not a title.
      const title = isPlaceholderTitle(episode.title) ? null : episode.title;
      await tx
        .update(episodes)
        .set({
          title: sql`coalesce(${episodes.title}, ${title})`,
          titleEnglish: sql`coalesce(${episodes.titleEnglish}, ${title})`,
          lengthMinutes: sql`coalesce(${episodes.lengthMinutes}, ${minutes})`,
          updatedAt: new Date(),
        })
        .where(eq(episodes.id, row.id));
    }
  });
  if (written.size < aligned.length)
    log.warn(
      `Crunchyroll: ${aligned.length - written.size} episode(s) of ${catalogue.series.id} are already mapped to another anime (anime ${context.id})`,
    );
  return written;
}

/**
 * Crunchyroll language tracks for one anime, per episode where the episodes
 * can be aligned. Crunchyroll's catalogue is regional, so an absent track is
 * never evidence that a dub or subtitle does not exist: only present tracks
 * are recorded.
 */
export async function syncCrunchyrollLanguages(
  animeId: number,
  api: CrunchyrollApi = liveApi,
): Promise<CrunchyrollSyncResult> {
  const context = await loadContext(animeId);
  const { resolution, reason } = await resolve(api, context);
  if (!resolution) {
    await clearMappings(animeId);
    await clearSnapshot(animeId);
    return { status: "unmatched", reason };
  }

  const { catalogue, alignment, authoritative } = resolution;
  const rowsByNumber = new Map(context.episodeRows.map((row) => [row.number, row]));
  const aligned = (alignment?.episodes ?? [])
    .map(({ localNumber, episode }) => ({ row: rowsByNumber.get(localNumber), episode }))
    .filter(
      (pair): pair is { row: AnimeContext["episodeRows"][number]; episode: CrunchyrollEpisode } =>
        Boolean(pair.row),
    );
  const mapped = await persistMapping(context, resolution, aligned);

  const confidence = authoritative ? 95 : 90;
  const sourceUrl = seriesUrl(catalogue.series);
  const evidence = new Map<string, ProviderLanguageAssertion>();
  const episodeRows: NonNullable<
    Parameters<typeof replaceProviderLanguageSnapshot>[0]["episodes"]
  > = [];
  const addEvidence = (languageCode: string, mediaType: "audio" | "subtitle") =>
    evidence.set(`${languageCode}:${mediaType}`, {
      languageCode,
      mediaType,
      evidenceType: mediaType === "audio" ? "provider_audio" : "provider_subtitle",
      sourceUrl,
      value: "available",
      confidence,
    });

  const sources = alignment
    ? alignment.episodes.map((pair) => pair.episode)
    : catalogue.seasons[0]!.episodes.filter(isMainEpisode);
  for (const episode of sources) {
    const languages = episodeLanguages(episode);
    for (const code of languages.audio) addEvidence(code, "audio");
    for (const code of languages.subtitle) addEvidence(code, "subtitle");
  }
  for (const { row, episode } of aligned) {
    if (!mapped.has(row.id)) continue;
    const languages = episodeLanguages(episode);
    for (const [mediaType, codes] of [
      ["audio", languages.audio],
      ["subtitle", languages.subtitle],
    ] as const)
      for (const languageCode of codes)
        episodeRows.push({
          episodeNumber: row.number,
          languageCode,
          mediaType,
          status: "available",
          confidence,
        });
  }

  await replaceProviderLanguageSnapshot({
    animeId,
    provider: PROVIDER,
    sourceUrlPrefixes: [SOURCE_PREFIX, SNAPSHOT_URN],
    evidenceTypes: ["provider_audio", "provider_subtitle"],
    evidence: [...evidence.values()],
    episodes: episodeRows,
  });

  return {
    status: alignment ? "matched" : "series-only",
    seriesId: catalogue.series.id,
    tier: alignment?.tier,
    episodes: mapped.size,
    reason,
  };
}
