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
import { analyzeObservedSegmentTransform } from "./provider-merged-season-transform-analysis";
import {
  classifyPrefixSegmentEvidence,
  type PrefixSegmentRejectReason,
} from "./provider-prefix-segment-evidence";

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
  localEpisodeNumber: number;
  localKind: string;
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
  endDate: string | null;
}

interface AuthoritativeEpisode {
  providerEpisodeId: string;
  providerEpisodeNumber: number;
  airDate: string | null;
}

interface SeasonEvidence {
  episodes: AuthoritativeEpisode[];
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

function episodeIdentityKey(provider: string, providerEpisodeId: string): string {
  return `${provider}\u0000${providerEpisodeId}`;
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
    select
      e.anime_id as "animeId",
      em.provider,
      em.provider_id as "providerEpisodeId",
      e.number as "localEpisodeNumber",
      e.kind as "localKind"
    from public.episode_mappings em
    join public.episodes e on e.id = em.episode_id
    where em.provider in ('thetvdb', 'tmdb')
    order by em.provider, em.provider_id
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
      start_date as "startDate",
      end_date as "endDate"
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
        airDate: episode.aired?.trim() || null,
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
    3,
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
    throw new Error("TVDB_API_KEY is required for prefix segment evidence diagnosis");
  }
  if (orphanRows.some((row) => row.provider === "tmdb") && !process.env.TMDB_API_KEY?.trim()) {
    throw new Error("TMDB_API_KEY is required for prefix segment evidence diagnosis");
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

  const episodeOwnerByIdentity = new Map<string, EpisodeMappingRow>();
  for (const row of episodeRows) {
    episodeOwnerByIdentity.set(
      episodeIdentityKey(row.provider, row.providerEpisodeId),
      row,
    );
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
                  airDate: episode.air_date?.trim() || null,
                }))
                .sort((a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber),
            }));
    evidenceCache.set(key, promise);
    return promise;
  };

  const outcomes = await mapWithConcurrency(resolvedGroups, 4, async (group) => {
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
    const targetMeta = metaByAnime.get(group.animeId);
    const ownerMeta = metaByAnime.get(owner.animeId);
    const mismatch = classifyProviderLocalCountMismatch({
      authoritativeEpisodeNumbers: evidence.episodes.map(
        (episode) => episode.providerEpisodeNumber,
      ),
      targetLocalNormalEpisodeNumbers: localNumbersByAnime.get(group.animeId) ?? [],
      targetMetadataEpisodeCount: targetMeta?.episodeCount ?? null,
    });
    if (!mismatch || mismatch.classification !== "local-mismatch-metadata-differs") return null;

    const targetAnalysis = analyzeObservedSegmentTransform({
      authoritativeEpisodes: evidence.episodes.map((episode) => ({
        providerEpisodeId: episode.providerEpisodeId,
        providerEpisodeNumber: episode.providerEpisodeNumber,
      })),
      observedMappings: group.rows.map((row) => ({
        providerEpisodeId: row.providerId,
        localEpisodeNumber: row.localEpisodeNumber,
      })),
      metadataEpisodeCount: targetMeta?.episodeCount ?? null,
    });
    if (!targetAnalysis.transform) return null;

    const providerNumberById = new Map(
      evidence.episodes.map((episode) => [
        episode.providerEpisodeId,
        episode.providerEpisodeNumber,
      ]),
    );
    const observedTargetProviderEpisodeNumbers = group.rows
      .map((row) => providerNumberById.get(row.providerId))
      .filter((number): number is number => number !== undefined);

    const ownership = evidence.episodes.flatMap((episode) => {
      const mapped = episodeOwnerByIdentity.get(
        episodeIdentityKey(group.provider, episode.providerEpisodeId),
      );
      return mapped
        ? [{ providerEpisodeNumber: episode.providerEpisodeNumber, animeId: mapped.animeId }]
        : [];
    });

    const prefix = classifyPrefixSegmentEvidence({
      authoritativeEpisodes: evidence.episodes.map((episode) => ({
        providerEpisodeNumber: episode.providerEpisodeNumber,
        airDate: episode.airDate,
      })),
      targetMetadataEpisodeCount: targetMeta?.episodeCount ?? null,
      targetLocalNormalEpisodeNumbers: localNumbersByAnime.get(group.animeId) ?? [],
      targetTransform: targetAnalysis.transform,
      observedTargetProviderEpisodeNumbers,
      ownership,
      targetAnimeId: group.animeId,
      currentOwnerAnimeId: owner.animeId,
      targetStartDate: targetMeta?.startDate ?? null,
      targetEndDate: targetMeta?.endDate ?? null,
    });

    return {
      provider: group.provider,
      providerId: group.providerId,
      targetAnimeId: group.animeId,
      targetTitle: targetMeta?.titleRomaji ?? null,
      targetFormat: targetMeta?.format ?? null,
      targetEpisodeCount: targetMeta?.episodeCount ?? null,
      targetStartDate: targetMeta?.startDate ?? null,
      targetEndDate: targetMeta?.endDate ?? null,
      currentOwnerAnimeId: owner.animeId,
      currentOwnerTitle: ownerMeta?.titleRomaji ?? null,
      currentOwnerFormat: ownerMeta?.format ?? null,
      currentOwnerEpisodeCount: ownerMeta?.episodeCount ?? null,
      currentOwnerStartDate: ownerMeta?.startDate ?? null,
      authoritativeEpisodeCount: evidence.episodes.length,
      targetObservedPairCount: targetAnalysis.transform.observedPairCount,
      prefix,
    };
  });

  const samples = outcomes.filter((outcome): outcome is NonNullable<typeof outcome> => Boolean(outcome));
  const strong = samples.filter((sample) => sample.prefix.ok);
  const rejected = samples.filter((sample) => !sample.prefix.ok);

  const rejectionCounts = new Map<string, number>();
  const byProvider = new Map<Provider, { groups: number; strong: number; missingMoves: number }>([
    ["thetvdb", { groups: 0, strong: 0, missingMoves: 0 }],
    ["tmdb", { groups: 0, strong: 0, missingMoves: 0 }],
  ]);

  for (const sample of samples) {
    const summary = byProvider.get(sample.provider)!;
    summary.groups += 1;
    if (sample.prefix.ok) {
      summary.strong += 1;
      summary.missingMoves += sample.prefix.missingProviderEpisodeNumbers.length;
    } else if (sample.prefix.reason) {
      increment(rejectionCounts, sample.prefix.reason);
    }
  }

  strong.sort(
    (a, b) =>
      b.prefix.targetCoverageRatio! - a.prefix.targetCoverageRatio! ||
      b.targetObservedPairCount - a.targetObservedPairCount ||
      a.targetAnimeId - b.targetAnimeId,
  );
  rejected.sort(
    (a, b) =>
      (a.prefix.reason ?? "").localeCompare(b.prefix.reason ?? "") ||
      b.targetObservedPairCount - a.targetObservedPairCount ||
      a.targetAnimeId - b.targetAnimeId,
  );

  return {
    ok: true,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    operation: {
      code: "diagnose-provider-prefix-segment-evidence",
      description:
        "For remaining provider-season collisions whose target has a linear zero-offset transform but a smaller AniList/local episode count than the authoritative provider season, test whether the target is independently supported as a strict provider-season prefix. A strong prefix requires exact local 1..N coverage, a zero-offset inferred provider range 1..N, a strict majority of target provider episodes already observed, every missing provider episode inside the prefix already owned by the current collision owner, and both provider prefix boundary air dates within 180 days of the target AniList start/end dates. This is diagnostic-only and never writes data.",
      resolvedCollisionGroups: resolvedGroups.length,
      evaluatedPrefixGroups: samples.length,
      strongPrefixSegmentGroups: strong.length,
      strongPrefixEpisodeMappingsToReassign: strong.reduce(
        (sum, sample) => sum + sample.prefix.missingProviderEpisodeNumbers.length,
        0,
      ),
      byProvider: Object.fromEntries(byProvider.entries()),
      rejectionCounts: Object.fromEntries(
        [...rejectionCounts.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      strongSamples: strong.slice(0, 100),
      rejectedSamples: rejected.slice(0, 100).map((sample) => ({
        provider: sample.provider,
        providerId: sample.providerId,
        targetAnimeId: sample.targetAnimeId,
        targetTitle: sample.targetTitle,
        currentOwnerAnimeId: sample.currentOwnerAnimeId,
        currentOwnerTitle: sample.currentOwnerTitle,
        authoritativeEpisodeCount: sample.authoritativeEpisodeCount,
        targetEpisodeCount: sample.targetEpisodeCount,
        targetObservedPairCount: sample.targetObservedPairCount,
        reason: sample.prefix.reason as PrefixSegmentRejectReason | null,
        targetCoverageRatio: sample.prefix.targetCoverageRatio,
        missingProviderEpisodeNumbers: sample.prefix.missingProviderEpisodeNumbers,
        missingOwnerAnimeIds: sample.prefix.missingOwnerAnimeIds,
        providerPrefixFirstAirDate: sample.prefix.providerPrefixFirstAirDate,
        providerPrefixLastAirDate: sample.prefix.providerPrefixLastAirDate,
        startDateDeltaDays: sample.prefix.startDateDeltaDays,
        endDateDeltaDays: sample.prefix.endDateDeltaDays,
      })),
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
