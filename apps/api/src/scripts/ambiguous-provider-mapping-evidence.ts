import { sql, type SQL } from "drizzle-orm";

import { db } from "@anicore/db";
import { getTvdbOfficialEpisodes, getTvdbSeriesExtended } from "@anicore/providers/thetvdb/client";
import { TMDB } from "@api-wrappers/tmdb-wrapper";

import {
  diagnoseAmbiguousMappingGroup,
  parseProviderSeasonId,
  type AmbiguousMappingAnimeIdentity,
  type AmbiguousMappingGroupDiagnosis,
  type AmbiguousMappingProviderEvidence,
  type ProviderEvidenceStatus,
} from "./ambiguous-provider-mapping-diagnosis";

export type Provider = "thetvdb" | "tmdb";

export interface AmbiguousMappingRow {
  animeId: number;
  provider: Provider;
  providerId: string;
  providerUrl: string | null;
  source: string;
  confidence: number;
  isPrimary: boolean;
}

export interface AnimeIdentityRow extends AmbiguousMappingAnimeIdentity {}

export interface AuthoritativeProviderEpisode {
  providerEpisodeId: string;
  providerEpisodeNumber: number;
  seasonNumber: number | null;
}

export type AuthoritativeSeasonFetchState =
  | "ok"
  | "malformed"
  | "not-found"
  | "fetch-failed"
  | "empty";

export interface AuthoritativeSeasonResult {
  state: AuthoritativeSeasonFetchState;
  episodes: AuthoritativeProviderEpisode[];
}

export interface AmbiguousMappingEvidenceSourceOptions {
  tvdbApiKey?: string;
  tmdbApiKey?: string;
}

export interface AmbiguousMappingDiagnosisResult {
  groups: AmbiguousMappingGroupDiagnosis[];
  ambiguousMappings: number;
}

export interface AmbiguousMappingEvidenceSourceArgs {
  rows?: AmbiguousMappingRow[];
  identityRows?: AnimeIdentityRow[];
}

async function queryRows<T>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as T[];
}

export async function mapWithConcurrency<T, R>(
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

function errorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function isNotFoundError(error: unknown): boolean {
  return errorStatus(error) === 404 || /request failed:\s*404(?:\s|:|$)/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function missingEvidence(status: ProviderEvidenceStatus): AmbiguousMappingProviderEvidence {
  return {
    status,
    providerSeriesName: null,
    providerSlug: null,
    providerFirstAired: null,
    providerSeasonFirstAired: null,
    providerSeasonEpisodeCount: null,
    providerShowEpisodeCount: null,
  };
}

interface TvdbSeriesRecord {
  name: string;
  slug: string | null;
  firstAired: string | null;
}

interface TvdbEpisodeRecord {
  id: number;
  number: number | null;
  seasonNumber: number | null;
  aired: string | null;
}

interface TmdbShowRecord {
  name: string;
  firstAired: string | null;
  showEpisodeCount: number | null;
}

interface TmdbSeasonRecord {
  episodes: TvdbEpisodeRecord[];
  airDate: string | null;
}

export async function loadAmbiguousMappingRows(): Promise<AmbiguousMappingRow[]> {
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

export async function loadAnimeIdentity(): Promise<AnimeIdentityRow[]> {
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

/**
 * Authoritative provider evidence source shared by the ambiguous-mapping
 * diagnosis and the repair planner. Provider responses are cached per
 * candidate so diagnosis and episode-scope analysis never duplicate API
 * calls. Never mutates the database.
 */
export class AmbiguousMappingEvidenceSource {
  private readonly tvdbSeries = new Map<number, TvdbSeriesRecord | null>();
  private readonly tvdbEpisodes = new Map<number, TvdbEpisodeRecord[] | null>();
  private readonly tmdbShows = new Map<number, TmdbShowRecord | null>();
  private readonly tmdbSeasons = new Map<string, TmdbSeasonRecord | null>();
  private tmdbClient: TMDB | null = null;

  constructor(private readonly options: AmbiguousMappingEvidenceSourceOptions = {}) {}

  private getTmdb(): TMDB {
    if (!this.tmdbClient) {
      const apiKey = this.options.tmdbApiKey;
      if (!apiKey) throw new Error("TMDB_API_KEY is required");
      this.tmdbClient = new TMDB({ apiKey });
    }
    return this.tmdbClient;
  }

  private async tvdbSeriesState(showId: number): Promise<{
    series: TvdbSeriesRecord | null;
    state: "ok" | "not-found" | "fetch-failed";
  }> {
    let series = this.tvdbSeries.get(showId);
    if (series === undefined) {
      try {
        const record = await getTvdbSeriesExtended(showId);
        series = record
          ? {
              name: record.name,
              slug: record.slug ?? null,
              firstAired: record.firstAired ?? null,
            }
          : null;
      } catch (error) {
        if (isNotFoundError(error)) return { series: null, state: "not-found" };
        return { series: null, state: "fetch-failed" };
      }
      this.tvdbSeries.set(showId, series);
    }
    if (!series) return { series: null, state: "not-found" };
    return { series, state: "ok" };
  }

  private async tvdbEpisodesState(showId: number): Promise<{
    episodes: TvdbEpisodeRecord[] | null;
    state: "ok" | "not-found" | "fetch-failed";
  }> {
    let episodes = this.tvdbEpisodes.get(showId);
    if (episodes === undefined) {
      try {
        const allEpisodes = await getTvdbOfficialEpisodes(showId, "eng");
        episodes = allEpisodes.map((episode) => ({
          id: episode.id,
          number: Number.isInteger(episode.number) ? episode.number! : null,
          seasonNumber: typeof episode.seasonNumber === "number" ? episode.seasonNumber : null,
          aired: episode.aired?.trim() || null,
        }));
      } catch (error) {
        if (isNotFoundError(error)) {
          this.tvdbEpisodes.set(showId, null);
          return { episodes: null, state: "not-found" };
        }
        return { episodes: null, state: "fetch-failed" };
      }
      this.tvdbEpisodes.set(showId, episodes);
    }
    if (!episodes) return { episodes: null, state: "not-found" };
    return { episodes, state: "ok" };
  }

  private async tmdbShowState(showId: number): Promise<{
    show: TmdbShowRecord | null;
    state: "ok" | "not-found" | "fetch-failed";
  }> {
    let show = this.tmdbShows.get(showId);
    if (show === undefined) {
      try {
        const details = await this.getTmdb().tvShows.details(showId, undefined, "en-US");
        show = {
          name: details.name,
          firstAired: details.first_air_date?.trim() || null,
          showEpisodeCount: details.number_of_episodes > 0 ? details.number_of_episodes : null,
        };
      } catch (error) {
        if (isNotFoundError(error)) {
          this.tmdbShows.set(showId, null);
          return { show: null, state: "not-found" };
        }
        return { show: null, state: "fetch-failed" };
      }
      this.tmdbShows.set(showId, show);
    }
    if (!show) return { show: null, state: "not-found" };
    return { show, state: "ok" };
  }

  private async tmdbSeasonState(showId: number, seasonNumber: number): Promise<{
    season: TmdbSeasonRecord | null;
    state: "ok" | "not-found" | "fetch-failed";
  }> {
    const key = `${showId}:${seasonNumber}`;
    let season = this.tmdbSeasons.get(key);
    if (season === undefined) {
      try {
        const details = await this.getTmdb().tvSeasons.details(
          { tvShowID: showId, seasonNumber },
          undefined,
          { language: "en-US" },
        );
        season = {
          episodes: (details.episodes ?? [])
            .map((episode) => ({
              id: episode.id,
              number: Number.isInteger(episode.episode_number) ? episode.episode_number! : null,
              seasonNumber,
              aired: null,
            }))
            .sort((a, b) => (a.number ?? 0) - (b.number ?? 0)),
          airDate: details.air_date?.trim() || null,
        };
      } catch (error) {
        if (isNotFoundError(error)) {
          this.tmdbSeasons.set(key, null);
          return { season: null, state: "not-found" };
        }
        return { season: null, state: "fetch-failed" };
      }
      this.tmdbSeasons.set(key, season);
    }
    if (!season) return { season: null, state: "not-found" };
    return { season, state: "ok" };
  }

  /**
   * Authoritative season evidence identical to the diagnosis resolver:
   * series identity plus season-scoped and show-scoped first-air dates and
   * episode counts. Never returns null; failures are encoded in status.
   */
  async resolveCandidateEvidence(
    provider: Provider,
    providerId: string,
  ): Promise<AmbiguousMappingProviderEvidence> {
    const parsed = parseProviderSeasonId(providerId);
    if (!parsed) return missingEvidence("malformed");

    if (provider === "thetvdb") {
      const seriesLookup = await this.tvdbSeriesState(parsed.showId);
      if (!seriesLookup.series) return missingEvidence(seriesLookup.state);
      const episodesLookup = await this.tvdbEpisodesState(parsed.showId);
      if (!episodesLookup.episodes) {
        return {
          ...missingEvidence(episodesLookup.state),
          providerSeriesName: seriesLookup.series.name,
          providerSlug: seriesLookup.series.slug,
          providerFirstAired: seriesLookup.series.firstAired,
        };
      }
      const seasonEpisodes = episodesLookup.episodes.filter(
        (episode) => episode.seasonNumber === parsed.seasonNumber,
      );
      const aired = seasonEpisodes
        .map((episode) => episode.aired)
        .filter((value): value is string => Boolean(value))
        .sort();
      const numberedEpisodes = episodesLookup.episodes.filter(
        (episode) => (episode.seasonNumber ?? 0) > 0,
      );
      return {
        status: "ok",
        providerSeriesName: seriesLookup.series.name,
        providerSlug: seriesLookup.series.slug,
        providerFirstAired: seriesLookup.series.firstAired,
        providerSeasonFirstAired: aired[0] ?? null,
        providerSeasonEpisodeCount: seasonEpisodes.length > 0 ? seasonEpisodes.length : null,
        providerShowEpisodeCount: numberedEpisodes.length > 0 ? numberedEpisodes.length : null,
      };
    }

    const showLookup = await this.tmdbShowState(parsed.showId);
    if (!showLookup.show) return missingEvidence(showLookup.state);
    const seasonLookup = await this.tmdbSeasonState(parsed.showId, parsed.seasonNumber);
    if (!seasonLookup.season) {
      return {
        ...missingEvidence(seasonLookup.state),
        providerSeriesName: showLookup.show.name,
        providerFirstAired: showLookup.show.firstAired,
        providerShowEpisodeCount: showLookup.show.showEpisodeCount,
      };
    }
    return {
      status: "ok",
      providerSeriesName: showLookup.show.name,
      providerSlug: null,
      providerFirstAired: showLookup.show.firstAired,
      providerSeasonFirstAired: seasonLookup.season.airDate,
      providerSeasonEpisodeCount:
        seasonLookup.season.episodes.length > 0 ? seasonLookup.season.episodes.length : null,
      providerShowEpisodeCount: showLookup.show.showEpisodeCount,
    };
  }

  /**
   * Authoritative provider episode IDs for one candidate season, sharing the
   * diagnosis caches. Any incomplete or failed fetch is reported as a state;
   * callers must fail closed.
   */
  async authoritativeSeasonEpisodes(
    provider: Provider,
    providerId: string,
  ): Promise<AuthoritativeSeasonResult> {
    const parsed = parseProviderSeasonId(providerId);
    if (!parsed) return { state: "malformed", episodes: [] };

    if (provider === "thetvdb") {
      const episodesLookup = await this.tvdbEpisodesState(parsed.showId);
      if (!episodesLookup.episodes) {
        return { state: episodesLookup.state, episodes: [] };
      }
      const episodes = episodesLookup.episodes
        .filter((episode) => episode.seasonNumber === parsed.seasonNumber)
        .filter((episode) => episode.id > 0 && episode.number !== null && episode.number > 0)
        .map<AuthoritativeProviderEpisode>((episode) => ({
          providerEpisodeId: String(episode.id),
          providerEpisodeNumber: episode.number!,
          seasonNumber: episode.seasonNumber,
        }))
        .sort((a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber);
      if (episodes.length === 0) return { state: "empty", episodes: [] };
      return { state: "ok", episodes };
    }

    const seasonLookup = await this.tmdbSeasonState(parsed.showId, parsed.seasonNumber);
    if (!seasonLookup.season) {
      return { state: seasonLookup.state, episodes: [] };
    }
    const episodes = seasonLookup.season.episodes
      .filter((episode) => episode.id > 0 && episode.number !== null && episode.number > 0)
      .map<AuthoritativeProviderEpisode>((episode) => ({
        providerEpisodeId: String(episode.id),
        providerEpisodeNumber: episode.number!,
        seasonNumber: episode.seasonNumber,
      }))
      .sort((a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber);
    if (episodes.length === 0) return { state: "empty", episodes: [] };
    return { state: "ok", episodes };
  }

  /**
   * Live re-run of the ambiguous-mapping diagnosis using the same SQL and
   * provider evidence as the standalone diagnostic command. Groups are
   * derived dynamically; nothing is hard-coded.
   */
  async diagnoseGroups(
    args: AmbiguousMappingEvidenceSourceArgs = {},
  ): Promise<AmbiguousMappingDiagnosisResult> {
    const [rows, identityRows] =
      args.rows && args.identityRows
        ? [args.rows, args.identityRows]
        : await Promise.all([loadAmbiguousMappingRows(), loadAnimeIdentity()]);

    const hasTvdb = rows.some((row) => row.provider === "thetvdb");
    const hasTmdb = rows.some((row) => row.provider === "tmdb");
    if (hasTvdb && !this.options.tvdbApiKey?.trim()) {
      throw new Error("TVDB_API_KEY is required for ambiguous TVDB mapping diagnostics");
    }
    if (hasTmdb && !this.options.tmdbApiKey?.trim()) {
      throw new Error("TMDB_API_KEY is required for ambiguous TMDB mapping diagnostics");
    }

    const identityByAnimeId = new Map(identityRows.map((row) => [row.animeId, row]));

    const rowsByAnime = new Map<number, AmbiguousMappingRow[]>();
    for (const row of rows) {
      const list = rowsByAnime.get(row.animeId) ?? [];
      list.push(row);
      rowsByAnime.set(row.animeId, list);
    }

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
          evidence: AmbiguousMappingProviderEvidence;
        }> => {
          const evidence = await this.resolveCandidateEvidence(row.provider, row.providerId);
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
    return { groups, ambiguousMappings: rows.length };
  }
}