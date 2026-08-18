import { TMDB } from "@api-wrappers/tmdb-wrapper";
import { sql, type SQL } from "drizzle-orm";

import { closeDb, db } from "@anicore/db";
import {
  getTvdbSeasonEpisodes,
  getTvdbSeriesBySlug,
  type TvdbEpisodeBase,
  type TvdbSeriesBaseRecord,
} from "@anicore/providers/thetvdb/client";

import {
  buildTvdbSlugResolutionGroups,
  verifyResolvedTvdbSlugGroup,
  type TvdbSlugResolutionGroup,
} from "./orphan-tvdb-slug-repair";
import {
  buildTmdbResolvedCollisionGroups,
  type CollisionEpisodeMappingRow,
  type ResolvedCollisionGroup,
} from "./provider-collision-segment-plan";
import { classifyProviderLocalCountMismatch } from "./provider-local-count-mismatch-classification";
import type { WholeSeasonAuthoritativeEpisode } from "./whole-season-ownership-repair-plan";

type Provider = "thetvdb" | "tmdb";

interface ProviderEntityMappingRow {
  provider: Provider;
  providerId: string;
  animeId: number;
  segmentCount: number;
}

interface LegacyParentRow {
  animeId: number;
  provider: Provider;
  providerId: string;
}

interface EpisodeMappingRow {
  animeId: number;
  provider: Provider;
  providerEpisodeId: string;
}

interface LocalNormalEpisodeRow {
  animeId: number;
  episodeNumber: number;
}

interface AnimeMetaRow {
  animeId: number;
  titleRomaji: string;
  format: string | null;
  episodeCount: number | null;
  startDate: string | null;
}

interface SeasonEvidence {
  episodes: WholeSeasonAuthoritativeEpisode[];
}

async function queryRows<T extends Record<string, unknown>>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as T[];
}

function identityKey(provider: string, providerId: string): string {
  return `${provider}\u0000${providerId}`;
}

function animeProviderKey(animeId: number, provider: string): string {
  return `${animeId}\u0000${provider}`;
}

function parseProviderIdentity(providerId: string): {
  entityId: number;
  seasonNumber: number;
} | null {
  const [entityIdRaw, seasonNumberRaw, ...rest] = providerId.split(":");
  if (rest.length > 0 || !entityIdRaw || !seasonNumberRaw) return null;
  const entityId = Number(entityIdRaw);
  const seasonNumber = Number(seasonNumberRaw);
  if (!Number.isInteger(entityId) || entityId <= 0) return null;
  if (!Number.isInteger(seasonNumber) || seasonNumber <= 0) return null;
  return { entityId, seasonNumber };
}

async function loadNormalOrphanRows(): Promise<CollisionEpisodeMappingRow[]> {
  return queryRows<CollisionEpisodeMappingRow>(sql`
    select
      em.id as "episodeMappingId",
      e.anime_id as "animeId",
      em.episode_id as "episodeId",
      em.provider,
      em.provider_id as "providerId",
      em.provider_url as "providerUrl",
      em.provider_episode_number as "providerEpisodeNumber",
      e.season_number as "episodeSeasonNumber",
      em.source,
      em.confidence,
      e.number as "localEpisodeNumber",
      (
        select count(*)::int
        from public.episodes local_episode
        where local_episode.anime_id = e.anime_id
          and local_episode.kind = 'normal'
      ) as "localNormalEpisodeCount"
    from public.episode_mappings em
    join public.episodes e on e.id = em.episode_id
    where em.provider in ('thetvdb', 'tmdb')
      and e.kind = 'normal'
      and not exists (
        select 1
        from public.anime_mappings am
        where am.anime_id = e.anime_id
          and am.provider = em.provider
      )
    order by e.anime_id, em.provider, e.number, em.id
  `);
}

async function loadProviderEntityMappings(): Promise<ProviderEntityMappingRow[]> {
  return queryRows<ProviderEntityMappingRow>(sql`
    select
      pe.provider,
      pe.provider_id as "providerId",
      apm.anime_id as "animeId",
      (
        select count(*)::int
        from public.anime_provider_segments aps
        where aps.anime_provider_mapping_id = apm.id
      ) as "segmentCount"
    from public.provider_entities pe
    join public.anime_provider_mappings apm
      on apm.provider_entity_id = pe.id
    where pe.provider in ('thetvdb', 'tmdb')
    order by pe.provider, pe.provider_id, apm.anime_id
  `);
}

async function loadLegacyParents(): Promise<LegacyParentRow[]> {
  return queryRows<LegacyParentRow>(sql`
    select anime_id as "animeId", provider, provider_id as "providerId"
    from public.anime_mappings
    where provider in ('thetvdb', 'tmdb')
    order by provider, provider_id, anime_id
  `);
}

async function loadEpisodeMappings(): Promise<EpisodeMappingRow[]> {
  return queryRows<EpisodeMappingRow>(sql`
    select e.anime_id as "animeId", em.provider, em.provider_id as "providerEpisodeId"
    from public.episode_mappings em
    join public.episodes e on e.id = em.episode_id
    where em.provider in ('thetvdb', 'tmdb')
    order by e.anime_id, em.provider, em.provider_id
  `);
}

async function loadLocalNormalEpisodes(): Promise<LocalNormalEpisodeRow[]> {
  return queryRows<LocalNormalEpisodeRow>(sql`
    select anime_id as "animeId", number as "episodeNumber"
    from public.episodes
    where kind = 'normal'
    order by anime_id, number
  `);
}

async function loadAnimeMeta(): Promise<AnimeMetaRow[]> {
  return queryRows<AnimeMetaRow>(sql`
    select
      id as "animeId",
      title_romaji as "titleRomaji",
      format,
      episode_count as "episodeCount",
      start_date as "startDate"
    from public.anime
    order by id
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

function isTvdbNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /TVDB request failed:\s*404(?:\s|:|$)/i.test(message);
}

function tvdbSeasonEvidence(episodes: TvdbEpisodeBase[]): SeasonEvidence {
  return {
    episodes: episodes
      .filter(
        (episode) =>
          Number.isInteger(episode.id) &&
          episode.id > 0 &&
          Number.isInteger(episode.number) &&
          (episode.number ?? 0) > 0,
      )
      .map((episode) => ({
        providerEpisodeId: String(episode.id),
        providerEpisodeNumber: episode.number!,
      }))
      .sort((a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber),
  };
}

async function resolveTvdbGroups(
  rows: CollisionEpisodeMappingRow[],
  evidenceCache: Map<string, Promise<SeasonEvidence>>,
): Promise<ResolvedCollisionGroup[]> {
  const groupPlan = buildTvdbSlugResolutionGroups(rows);
  const rowsByAnime = new Map<number, CollisionEpisodeMappingRow[]>();
  for (const row of rows) {
    if (row.provider !== "thetvdb") continue;
    const list = rowsByAnime.get(row.animeId) ?? [];
    list.push(row);
    rowsByAnime.set(row.animeId, list);
  }

  const seriesCache = new Map<string, Promise<TvdbSeriesBaseRecord | null>>();
  const seasonCache = new Map<string, Promise<TvdbEpisodeBase[]>>();
  const getSeries = (slug: string): Promise<TvdbSeriesBaseRecord | null> => {
    const key = slug.trim().toLowerCase();
    let promise = seriesCache.get(key);
    if (!promise) {
      promise = getTvdbSeriesBySlug(slug);
      seriesCache.set(key, promise);
    }
    return promise;
  };
  const getSeason = (seriesId: number, seasonNumber: number): Promise<TvdbEpisodeBase[]> => {
    const key = `${seriesId}:${seasonNumber}`;
    let promise = seasonCache.get(key);
    if (!promise) {
      promise = getTvdbSeasonEpisodes(seriesId, seasonNumber, "eng");
      seasonCache.set(key, promise);
    }
    return promise;
  };

  const outcomes = await mapWithConcurrency(
    groupPlan.groups,
    4,
    async (group: TvdbSlugResolutionGroup): Promise<ResolvedCollisionGroup | null> => {
      let series: TvdbSeriesBaseRecord | null;
      try {
        series = await getSeries(group.slug);
      } catch (error) {
        if (isTvdbNotFoundError(error)) return null;
        throw error;
      }
      if (!series) return null;
      const season = await getSeason(series.id, group.seasonNumber);
      const verified = verifyResolvedTvdbSlugGroup(group, series, season);
      if (!verified) return null;
      evidenceCache.set(
        identityKey("thetvdb", verified.providerId),
        Promise.resolve(tvdbSeasonEvidence(season)),
      );
      return {
        animeId: verified.animeId,
        provider: "thetvdb",
        providerId: verified.providerId,
        providerSlug: verified.providerSlug,
        providerUrl: verified.providerUrl,
        confidence: verified.confidence,
        rows: rowsByAnime.get(verified.animeId) ?? [],
      };
    },
  );

  return outcomes.filter((group): group is ResolvedCollisionGroup => Boolean(group));
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

async function run(): Promise<Record<string, unknown>> {
  const [orphanRows, entityMappings, legacyParents, episodeRows, localRows, metaRows] =
    await Promise.all([
      loadNormalOrphanRows(),
      loadProviderEntityMappings(),
      loadLegacyParents(),
      loadEpisodeMappings(),
      loadLocalNormalEpisodes(),
      loadAnimeMeta(),
    ]);

  if (orphanRows.some((row) => row.provider === "thetvdb") && !process.env.TVDB_API_KEY?.trim()) {
    throw new Error("TVDB_API_KEY is required for provider local-count diagnosis");
  }
  if (orphanRows.some((row) => row.provider === "tmdb") && !process.env.TMDB_API_KEY?.trim()) {
    throw new Error("TMDB_API_KEY is required for provider local-count diagnosis");
  }

  let tmdb: TMDB | null = null;
  const getTmdb = (): TMDB => {
    if (!tmdb) {
      const apiKey = process.env.TMDB_API_KEY?.trim();
      if (!apiKey) throw new Error("TMDB_API_KEY is required");
      tmdb = new TMDB({ apiKey });
    }
    return tmdb;
  };

  const evidenceCache = new Map<string, Promise<SeasonEvidence>>();
  const tmdbPlan = buildTmdbResolvedCollisionGroups(orphanRows);
  const tvdbGroups = await resolveTvdbGroups(orphanRows, evidenceCache);
  const resolvedGroups = [...tmdbPlan.groups, ...tvdbGroups];

  const mappingsByEntity = new Map<string, ProviderEntityMappingRow[]>();
  const mappingsByAnimeProvider = new Map<string, ProviderEntityMappingRow[]>();
  for (const row of entityMappings) {
    const identity = identityKey(row.provider, row.providerId);
    const byEntity = mappingsByEntity.get(identity) ?? [];
    byEntity.push(row);
    mappingsByEntity.set(identity, byEntity);

    const animeProvider = animeProviderKey(row.animeId, row.provider);
    const byAnime = mappingsByAnimeProvider.get(animeProvider) ?? [];
    byAnime.push(row);
    mappingsByAnimeProvider.set(animeProvider, byAnime);
  }

  const legacyByIdentity = new Map<string, LegacyParentRow>();
  for (const row of legacyParents) {
    legacyByIdentity.set(identityKey(row.provider, row.providerId), row);
  }

  const episodeRowsByAnimeProvider = new Map<string, EpisodeMappingRow[]>();
  for (const row of episodeRows) {
    const key = animeProviderKey(row.animeId, row.provider);
    const list = episodeRowsByAnimeProvider.get(key) ?? [];
    list.push(row);
    episodeRowsByAnimeProvider.set(key, list);
  }

  const localNumbersByAnime = new Map<number, number[]>();
  for (const row of localRows) {
    const list = localNumbersByAnime.get(row.animeId) ?? [];
    list.push(row.episodeNumber);
    localNumbersByAnime.set(row.animeId, list);
  }
  const metaByAnime = new Map(metaRows.map((row) => [row.animeId, row]));

  const getSeasonEvidence = (provider: Provider, providerId: string): Promise<SeasonEvidence> => {
    const key = identityKey(provider, providerId);
    const cached = evidenceCache.get(key);
    if (cached) return cached;
    const parsed = parseProviderIdentity(providerId);
    if (!parsed) throw new Error(`Malformed ${provider} provider ID: ${providerId}`);

    const promise =
      provider === "thetvdb"
        ? getTvdbSeasonEpisodes(parsed.entityId, parsed.seasonNumber, "eng").then(
            tvdbSeasonEvidence,
          )
        : getTmdb()
            .tvSeasons.details(
              { tvShowID: parsed.entityId, seasonNumber: parsed.seasonNumber },
              undefined,
              { language: "en-US" },
            )
            .then((season) => ({
              episodes: (season.episodes ?? [])
                .filter(
                  (episode) =>
                    Number.isInteger(episode.id) &&
                    episode.id > 0 &&
                    Number.isInteger(episode.episode_number) &&
                    episode.episode_number > 0,
                )
                .map((episode) => ({
                  providerEpisodeId: String(episode.id),
                  providerEpisodeNumber: episode.episode_number,
                }))
                .sort((a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber),
            }));
    evidenceCache.set(key, promise);
    return promise;
  };

  const outcomes = await mapWithConcurrency(resolvedGroups, 5, async (group) => {
    const identity = identityKey(group.provider, group.providerId);
    const entityOwners = mappingsByEntity.get(identity) ?? [];
    if (entityOwners.length !== 1) return null;
    if (
      (mappingsByAnimeProvider.get(animeProviderKey(group.animeId, group.provider)) ?? [])
        .length > 0
    ) {
      return null;
    }

    const owner = entityOwners[0]!;
    if (owner.segmentCount !== 0) return null;
    const legacy = legacyByIdentity.get(identity);
    if (!legacy || legacy.animeId !== owner.animeId) return null;

    const evidence = await getSeasonEvidence(group.provider, group.providerId);
    const authoritativeIds = new Set(
      evidence.episodes.map((episode) => episode.providerEpisodeId),
    );
    const targetProviderRows =
      episodeRowsByAnimeProvider.get(animeProviderKey(group.animeId, group.provider)) ?? [];
    const ownerProviderRows =
      episodeRowsByAnimeProvider.get(animeProviderKey(owner.animeId, group.provider)) ?? [];
    if (targetProviderRows.some((row) => !authoritativeIds.has(row.providerEpisodeId))) return null;
    if (ownerProviderRows.some((row) => !authoritativeIds.has(row.providerEpisodeId))) return null;

    const meta = metaByAnime.get(group.animeId);
    const mismatch = classifyProviderLocalCountMismatch({
      authoritativeEpisodeNumbers: evidence.episodes.map(
        (episode) => episode.providerEpisodeNumber,
      ),
      targetLocalNormalEpisodeNumbers: localNumbersByAnime.get(group.animeId) ?? [],
      targetMetadataEpisodeCount: meta?.episodeCount ?? null,
    });
    if (!mismatch) return null;

    return {
      provider: group.provider,
      providerId: group.providerId,
      targetAnimeId: group.animeId,
      targetTitle: meta?.titleRomaji ?? null,
      targetFormat: meta?.format ?? null,
      targetStartDate: meta?.startDate ?? null,
      currentOwnerAnimeId: owner.animeId,
      orphanEpisodeMappingCount: group.rows.length,
      ...mismatch,
    };
  });

  const samples = outcomes.filter((outcome): outcome is NonNullable<typeof outcome> => Boolean(outcome));
  samples.sort(
    (a, b) =>
      a.classification.localeCompare(b.classification) ||
      b.authoritativeEpisodeCount - a.authoritativeEpisodeCount ||
      a.targetAnimeId - b.targetAnimeId,
  );

  const byClassification = new Map<string, number>();
  const byProvider = new Map<Provider, number>([
    ["thetvdb", 0],
    ["tmdb", 0],
  ]);
  let orphanEpisodeMappingsInMismatchGroups = 0;
  for (const sample of samples) {
    increment(byClassification, sample.classification);
    byProvider.set(sample.provider, (byProvider.get(sample.provider) ?? 0) + 1);
    orphanEpisodeMappingsInMismatchGroups += sample.orphanEpisodeMappingCount;
  }

  return {
    ok: true,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    operation: {
      code: "diagnose-provider-local-count-mismatches",
      description:
        "Classify remaining ownership-repair groups rejected specifically because the target anime's normal episode-row count differs from the authoritative TVDB/TMDB season. This command reproduces the repair's owner/entity/scope preconditions first, then compares provider episode numbering, AniCore local normal rows, and AniList metadata count. It never writes data.",
      resolvedCollisionGroups: resolvedGroups.length,
      localCountMismatchGroups: samples.length,
      orphanEpisodeMappingsInMismatchGroups,
      byProvider: Object.fromEntries(byProvider.entries()),
      byClassification: Object.fromEntries(
        [...byClassification.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      samples: samples.slice(0, 120),
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
