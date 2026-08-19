import { sql, type SQL } from "drizzle-orm";

import { closeDb, db } from "@anicore/db";
import { getTvdbSeasonEpisodes, getTvdbSeriesExtended } from "@anicore/providers/thetvdb/client";
import { TMDB } from "@api-wrappers/tmdb-wrapper";

import {
  diagnoseAmbiguousMappingGroup,
  type AmbiguousMappingAnimeIdentity,
  type AmbiguousMappingGroupDiagnosis,
  type AmbiguousMappingProviderEvidence,
} from "./ambiguous-provider-mapping-diagnosis";

type Provider = "thetvdb" | "tmdb";

interface AmbiguousMappingRow extends Record<string, unknown> {
  animeId: number;
  provider: Provider;
  providerId: string;
  providerUrl: string | null;
  source: string;
  confidence: number;
  isPrimary: boolean;
}

interface AnimeIdentityRow extends Record<string, unknown> {
  animeId: number;
  titleRomaji: string;
  titleEnglish: string | null;
  titleNative: string | null;
  titleUserPreferred: string | null;
  synonymsJson: string;
  episodeCount: number | null;
  startDate: string | null;
  format: string | null;
  seasonYear: number | null;
}

async function queryRows<T extends Record<string, unknown>>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as T[];
}

function parseProviderSeasonId(providerId: string): { showId: number; seasonNumber: number } | null {
  const [showIdValue, seasonValue] = providerId.split(":");
  const showId = Number(showIdValue);
  const seasonNumber = Number(seasonValue);
  if (!Number.isInteger(showId) || showId <= 0) return null;
  if (!Number.isInteger(seasonNumber) || seasonNumber <= 0) return null;
  return { showId, seasonNumber };
}

async function loadAmbiguousMappingRows(): Promise<AmbiguousMappingRow[]> {
  return queryRows<AmbiguousMappingRow>(sql`
    select
      am.anime_id as "animeId",
      am.provider,
      am.provider_id as "providerId",
      am.provider_url as "providerUrl",
      am.source,
      am.confidence,
      am.is_primary as "isPrimary"
    from public.anime_mappings am
    join public.anime a on a.id = am.anime_id
    where am.provider in ('thetvdb', 'tmdb')
      and a.title_romaji is not null
      and am.anime_id in (
        select inner_map.anime_id
        from public.anime_mappings inner_map
        where inner_map.provider = am.provider
        group by inner_map.anime_id
        having count(*) > 1
          and count(*) filter (where inner_map.is_primary = true) <> 1
      )
    order by am.anime_id, am.provider, am.id
  `);
}

async function loadAnimeIdentity(): Promise<AnimeIdentityRow[]> {
  return queryRows<AnimeIdentityRow>(sql`
    select
      id as "animeId",
      title_romaji as "titleRomaji",
      title_english as "titleEnglish",
      title_native as "titleNative",
      title_user_preferred as "titleUserPreferred",
      synonyms_json as "synonymsJson",
      episode_count as "episodeCount",
      start_date as "startDate",
      format,
      season_year as "seasonYear"
    from public.anime
    where title_romaji is not null
  `);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

interface TvdbCache {
  series: Map<number, { name: string; slug: string | null; firstAired: string | null } | null>;
  seasons: Map<string, { episodeCount: number | null; firstAired: string | null } | null>;
}

async function resolveTvdbEvidence(
  cache: TvdbCache,
  providerId: string,
): Promise<AmbiguousMappingProviderEvidence | null> {
  const parsed = parseProviderSeasonId(providerId);
  if (!parsed) return null;

  let series = cache.series.get(parsed.showId);
  if (series === undefined) {
    try {
      const record = await getTvdbSeriesExtended(parsed.showId);
      series = record
        ? {
            name: record.name,
            slug: record.slug ?? null,
            firstAired: record.firstAired ?? null,
          }
        : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/TVDB request failed:\s*404(?:\s|:|$)/i.test(message)) throw error;
      series = null;
    }
    cache.series.set(parsed.showId, series);
  }
  if (!series) return null;

  const seasonKey = `${parsed.showId}:${parsed.seasonNumber}`;
  let season = cache.seasons.get(seasonKey);
  if (season === undefined) {
    try {
      const episodes = await getTvdbSeasonEpisodes(parsed.showId, parsed.seasonNumber, "eng");
      const aired = episodes
        .map((episode) => episode.aired?.trim())
        .filter((value): value is string => Boolean(value))
        .sort();
      season = {
        episodeCount: episodes.length > 0 ? episodes.length : null,
        firstAired: aired[0] ?? null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/TVDB request failed:\s*404(?:\s|:|$)/i.test(message)) throw error;
      season = null;
    }
    cache.seasons.set(seasonKey, season);
  }

  return {
    providerSeriesName: series.name,
    providerSlug: series.slug,
    providerFirstAired: series.firstAired,
    providerSeasonFirstAired: season?.firstAired ?? null,
    providerSeasonEpisodeCount: season?.episodeCount ?? null,
    providerShowEpisodeCount: null,
  };
}

interface TmdbCache {
  shows: Map<number, { name: string; firstAired: string | null; showEpisodeCount: number | null } | null>;
  seasons: Map<string, { episodeCount: number | null; firstAired: string | null } | null>;
}

async function resolveTmdbEvidence(
  client: TMDB,
  cache: TmdbCache,
  providerId: string,
): Promise<AmbiguousMappingProviderEvidence | null> {
  const parsed = parseProviderSeasonId(providerId);
  if (!parsed) return null;

  let show = cache.shows.get(parsed.showId);
  if (show === undefined) {
    try {
      const details = await client.tvShows.details(parsed.showId, undefined, "en-US");
      show = {
        name: details.name,
        firstAired: details.first_air_date?.trim() || null,
        showEpisodeCount: details.number_of_episodes > 0 ? details.number_of_episodes : null,
      };
    } catch {
      show = null;
    }
    cache.shows.set(parsed.showId, show);
  }
  if (!show) return null;

  const seasonKey = `${parsed.showId}:${parsed.seasonNumber}`;
  let season = cache.seasons.get(seasonKey);
  if (season === undefined) {
    try {
      const seasonDetails = await client.tvSeasons.details(
        { tvShowID: parsed.showId, seasonNumber: parsed.seasonNumber },
        undefined,
        { language: "en-US" },
      );
      season = {
        episodeCount:
          seasonDetails.episodes && seasonDetails.episodes.length > 0
            ? seasonDetails.episodes.length
            : null,
        firstAired: seasonDetails.air_date?.trim() || null,
      };
    } catch {
      season = null;
    }
    cache.seasons.set(seasonKey, season);
  }

  return {
    providerSeriesName: show.name,
    providerSlug: null,
    providerFirstAired: show.firstAired,
    providerSeasonFirstAired: season?.firstAired ?? null,
    providerSeasonEpisodeCount: season?.episodeCount ?? null,
    providerShowEpisodeCount: show.showEpisodeCount,
  };
}

async function run(): Promise<Record<string, unknown>> {
  const [rows, identityRows] = await Promise.all([
    loadAmbiguousMappingRows(),
    loadAnimeIdentity(),
  ]);

  const hasTvdb = rows.some((row) => row.provider === "thetvdb");
  const hasTmdb = rows.some((row) => row.provider === "tmdb");
  if (hasTvdb && !process.env.TVDB_API_KEY?.trim()) {
    throw new Error("TVDB_API_KEY is required for ambiguous TVDB mapping diagnostics");
  }
  if (hasTmdb && !process.env.TMDB_API_KEY?.trim()) {
    throw new Error("TMDB_API_KEY is required for ambiguous TMDB mapping diagnostics");
  }

  const identityByAnimeId = new Map(
    identityRows.map<[number, AmbiguousMappingAnimeIdentity]>((row) => [
      row.animeId,
      {
        animeId: row.animeId,
        titleRomaji: row.titleRomaji,
        titleEnglish: row.titleEnglish,
        titleNative: row.titleNative,
        titleUserPreferred: row.titleUserPreferred,
        synonymsJson: row.synonymsJson,
        episodeCount: row.episodeCount,
        startDate: row.startDate,
        format: row.format,
        seasonYear: row.seasonYear,
      },
    ]),
  );

  const rowsByAnime = new Map<number, AmbiguousMappingRow[]>();
  for (const row of rows) {
    const list = rowsByAnime.get(row.animeId) ?? [];
    list.push(row);
    rowsByAnime.set(row.animeId, list);
  }

  const tvdbCache: TvdbCache = { series: new Map(), seasons: new Map() };
  const tmdbClient = new TMDB({ apiKey: process.env.TMDB_API_KEY?.trim() });
  const tmdbCache: TmdbCache = { shows: new Map(), seasons: new Map() };

  const groups: AmbiguousMappingGroupDiagnosis[] = [];
  for (const [animeId, animeRows] of rowsByAnime) {
    const anime = identityByAnimeId.get(animeId);
    if (!anime) continue;

    const candidates = await mapWithConcurrency(
      animeRows,
      4,
      async (row): Promise<{
        provider: Provider;
        providerId: string;
        providerUrl: string | null;
        source: string;
        confidence: number;
        isPrimary: boolean;
        evidence: AmbiguousMappingProviderEvidence | null;
      }> => {
        const evidence =
          row.provider === "thetvdb"
            ? await resolveTvdbEvidence(tvdbCache, row.providerId)
            : await resolveTmdbEvidence(tmdbClient, tmdbCache, row.providerId);
        return {
          provider: row.provider,
          providerId: row.providerId,
          providerUrl: row.providerUrl,
          source: row.source,
          confidence: row.confidence,
          isPrimary: row.isPrimary,
          evidence,
        };
      },
    );

    groups.push(diagnoseAmbiguousMappingGroup({ anime, candidates }));
  }

  groups.sort((a, b) => a.animeId - b.animeId);

  const byVerdict = new Map<string, number>();
  for (const group of groups) {
    byVerdict.set(group.verdict, (byVerdict.get(group.verdict) ?? 0) + 1);
  }
  const byClassification = new Map<string, number>();
  for (const group of groups) {
    for (const candidate of group.candidates) {
      byClassification.set(
        candidate.classification,
        (byClassification.get(candidate.classification) ?? 0) + 1,
      );
    }
  }

  return {
    ok: true,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    operation: {
      code: "diagnose-ambiguous-provider-mappings",
      description:
        "Compare every TVDB/TMDB anime mapping that collides with a sibling mapping for the same anime/provider against authoritative provider series+season metadata (series name, first aired date, season episode count) and AniList identity (titles, start date, episode count). Reports per-candidate classification and per-group verdicts so a later plan/apply can retire the wrong ID and mark the correct one primary. This command never writes data.",
      ambiguousGroups: groups.length,
      ambiguousMappings: rows.length,
      byVerdict: Object.fromEntries(
        [...byVerdict.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      byClassification: Object.fromEntries(
        [...byClassification.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      groups,
    },
  };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length > 0) {
      throw new Error(
        `This command is diagnostic-only and accepts no arguments; received: ${args.join(" ")}`,
      );
    }
    console.log(JSON.stringify(await run(), null, 2));
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          mode: "dry-run",
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    await closeDb().catch(() => undefined);
  }
}