import { TMDB } from "@api-wrappers/tmdb-wrapper";
import { sql, type SQL } from "drizzle-orm";

import {
  closeDb,
  db,
  tryAcquireSyncLease,
  type SyncLease,
} from "@anicore/db";
import {
  getTvdbSeasonEpisodes,
  getTvdbSeriesBySlug,
  getTvdbSeriesExtended,
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
import {
  earliestProviderAirDate,
  verifyProviderSeasonAirdate,
  type ProviderSeasonAirdateRejectReason,
} from "./provider-season-airdate-verification";
import {
  verifyProviderSeasonIdentity,
  type ProviderSeasonIdentityRejectReason,
} from "./provider-season-identity-verification";
import {
  planEpisodeOwnershipTransfers,
  type EpisodeOwnershipTransferMove,
  type EpisodeOwnershipTransferRejectReason,
} from "./provider-season-ownership-transfer-plan";
import { parseRepairMappingsArgs } from "./repair-mappings-cli";
import {
  planWholeSeasonOwnershipRepair,
  type WholeSeasonAuthoritativeEpisode,
  type WholeSeasonMappedEpisode,
  type WholeSeasonRepairRejectReason,
} from "./whole-season-ownership-repair-plan";

type Mode = "dry-run" | "apply";
type Provider = "thetvdb" | "tmdb";
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ExecuteSql = (query: SQL) => Promise<unknown>;

type RejectReason =
  | WholeSeasonRepairRejectReason
  | ProviderSeasonIdentityRejectReason
  | ProviderSeasonAirdateRejectReason
  | EpisodeOwnershipTransferRejectReason
  | "missing-provider-entity"
  | "owner-count-not-one"
  | "target-provider-association-already-exists"
  | "missing-legacy-parent"
  | "legacy-parent-owner-mismatch"
  | "existing-provider-segments"
  | "missing-target-metadata"
  | "target-provider-scope-mismatch"
  | "owner-provider-scope-mismatch";

interface ProviderEntityMappingRow {
  providerEntityId: number;
  animeProviderMappingId: number;
  provider: Provider;
  providerId: string;
  animeId: number;
  confidence: number;
  source: string;
  isPrimary: boolean;
  segmentCount: number;
}

interface LegacyParentRow {
  legacyMappingId: number;
  animeId: number;
  provider: Provider;
  providerId: string;
}

interface EpisodeMappingRow {
  episodeMappingId: number;
  episodeId: number;
  animeId: number;
  provider: Provider;
  providerEpisodeId: string;
  localEpisodeNumber: number;
  localKind: string;
}

interface LocalEpisodeRow {
  episodeId: number;
  animeId: number;
  episodeNumber: number;
  kind: string;
}

interface AnimeMetaRow {
  animeId: number;
  titleRomaji: string;
  titleEnglish: string | null;
  titleNative: string | null;
  titleUserPreferred: string | null;
  synonymsJson: string;
  format: string | null;
  episodeCount: number | null;
  startDate: string | null;
}

interface SeasonEvidence {
  episodes: WholeSeasonAuthoritativeEpisode[];
  firstAirDate: string | null;
}

interface RepairCandidate {
  provider: Provider;
  providerId: string;
  providerEntityId: number;
  animeProviderMappingId: number;
  legacyMappingId: number;
  targetAnimeId: number;
  currentOwnerAnimeId: number;
  targetTitle: string;
  currentOwnerTitle: string | null;
  authoritativeEpisodeCount: number;
  orphanRowsResolved: number;
  episodeMoves: EpisodeOwnershipTransferMove[];
  providerFirstAirDate: string;
  startDateDeltaDays: number;
  bestTitleSimilarity: number;
}

interface PlanningOutcome {
  group: ResolvedCollisionGroup;
  candidate: RepairCandidate | null;
  reason: RejectReason | null;
}

interface RejectedSample {
  animeId: number;
  provider: Provider;
  providerId: string;
  reason: RejectReason;
}

interface CountRow {
  count: number;
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

async function queryRows<T extends Record<string, unknown>>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as T[];
}

async function transactionRows<T extends Record<string, unknown>>(
  tx: DbTransaction,
  query: SQL,
): Promise<T[]> {
  const result = await tx.execute(query);
  return [...result] as T[];
}

async function assertProviderMappingTablesExist(): Promise<void> {
  const [row] = await queryRows<{
    providerEntities: string | null;
    animeProviderMappings: string | null;
    animeProviderSegments: string | null;
  }>(sql`
    select
      to_regclass('public.provider_entities')::text as "providerEntities",
      to_regclass('public.anime_provider_mappings')::text as "animeProviderMappings",
      to_regclass('public.anime_provider_segments')::text as "animeProviderSegments"
  `);
  if (!row?.providerEntities || !row.animeProviderMappings || !row.animeProviderSegments) {
    throw new Error(
      "Segment-aware provider mapping tables do not exist; run `bun run db:migrate` before ownership repair",
    );
  }
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
      pe.id as "providerEntityId",
      apm.id as "animeProviderMappingId",
      pe.provider,
      pe.provider_id as "providerId",
      apm.anime_id as "animeId",
      apm.confidence,
      apm.source,
      apm.is_primary as "isPrimary",
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
    select
      id as "legacyMappingId",
      anime_id as "animeId",
      provider,
      provider_id as "providerId"
    from public.anime_mappings
    where provider in ('thetvdb', 'tmdb')
    order by provider, provider_id, anime_id
  `);
}

async function loadEpisodeMappings(): Promise<EpisodeMappingRow[]> {
  return queryRows<EpisodeMappingRow>(sql`
    select
      em.id as "episodeMappingId",
      em.episode_id as "episodeId",
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

async function loadLocalEpisodes(): Promise<LocalEpisodeRow[]> {
  return queryRows<LocalEpisodeRow>(sql`
    select
      id as "episodeId",
      anime_id as "animeId",
      number as "episodeNumber",
      kind
    from public.episodes
    order by anime_id, number, kind, id
  `);
}

async function loadAnimeMeta(): Promise<AnimeMetaRow[]> {
  return queryRows<AnimeMetaRow>(sql`
    select
      id as "animeId",
      title_romaji as "titleRomaji",
      title_english as "titleEnglish",
      title_native as "titleNative",
      title_user_preferred as "titleUserPreferred",
      synonyms_json as "synonymsJson",
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
    firstAirDate: earliestProviderAirDate(episodes.map((episode) => episode.aired)),
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

function uniqueIds(values: number[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Duplicate ${label} detected in repair plan`);
  }
}

function rejectedOutcome(
  group: ResolvedCollisionGroup,
  reason: RejectReason,
): PlanningOutcome {
  return { group, candidate: null, reason };
}

async function buildRepairPlan(): Promise<{
  resolvedCollisionGroups: number;
  candidates: RepairCandidate[];
  rejectedByReason: Record<string, number>;
  rejectedSamples: RejectedSample[];
}> {
  await assertProviderMappingTablesExist();

  const [orphanRows, entityMappings, legacyParents, episodeRows, localEpisodes, animeMetaRows] =
    await Promise.all([
      loadNormalOrphanRows(),
      loadProviderEntityMappings(),
      loadLegacyParents(),
      loadEpisodeMappings(),
      loadLocalEpisodes(),
      loadAnimeMeta(),
    ]);

  if (orphanRows.some((row) => row.provider === "thetvdb") && !process.env.TVDB_API_KEY?.trim()) {
    throw new Error("TVDB_API_KEY is required for provider season ownership repair");
  }
  if (orphanRows.some((row) => row.provider === "tmdb") && !process.env.TMDB_API_KEY?.trim()) {
    throw new Error("TMDB_API_KEY is required for provider season ownership repair");
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

  const episodeByProviderIdentity = new Map<string, EpisodeMappingRow>();
  const episodeRowsByAnimeProvider = new Map<string, EpisodeMappingRow[]>();
  const episodeProviderSlots = new Set<string>();
  for (const row of episodeRows) {
    episodeByProviderIdentity.set(
      episodeIdentityKey(row.provider, row.providerEpisodeId),
      row,
    );
    const key = animeProviderKey(row.animeId, row.provider);
    const list = episodeRowsByAnimeProvider.get(key) ?? [];
    list.push(row);
    episodeRowsByAnimeProvider.set(key, list);
    episodeProviderSlots.add(`${row.episodeId}\u0000${row.provider}`);
  }

  const localEpisodesByAnime = new Map<number, LocalEpisodeRow[]>();
  for (const row of localEpisodes) {
    const list = localEpisodesByAnime.get(row.animeId) ?? [];
    list.push(row);
    localEpisodesByAnime.set(row.animeId, list);
  }
  const metaByAnime = new Map(animeMetaRows.map((row) => [row.animeId, row]));

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
              firstAirDate: earliestProviderAirDate([
                season.air_date,
                ...(season.episodes ?? []).map((episode) => episode.air_date),
              ]),
            }));
    evidenceCache.set(key, promise);
    return promise;
  };

  const providerTitlesCache = new Map<string, Promise<string[]>>();
  const getProviderTitles = (provider: Provider, providerId: string): Promise<string[]> => {
    const key = identityKey(provider, providerId);
    const cached = providerTitlesCache.get(key);
    if (cached) return cached;
    const parsed = parseProviderIdentity(providerId);
    if (!parsed) throw new Error(`Malformed ${provider} provider ID: ${providerId}`);

    const promise =
      provider === "thetvdb"
        ? getTvdbSeriesExtended(parsed.entityId).then((series) =>
            series?.name ? [series.name] : [],
          )
        : getTmdb()
            .tvShows.details(parsed.entityId, undefined, "en-US")
            .then((show) =>
              [show.name, show.original_name].filter(
                (title): title is string => typeof title === "string" && title.trim().length > 0,
              ),
            );
    providerTitlesCache.set(key, promise);
    return promise;
  };

  const outcomes = await mapWithConcurrency<ResolvedCollisionGroup, PlanningOutcome>(
    resolvedGroups,
    5,
    async (group) => {
      const identity = identityKey(group.provider, group.providerId);
      const entityOwners = mappingsByEntity.get(identity) ?? [];
      if (entityOwners.length === 0) {
        return rejectedOutcome(group, "missing-provider-entity");
      }
      if (
        (mappingsByAnimeProvider.get(animeProviderKey(group.animeId, group.provider)) ?? [])
          .length > 0
      ) {
        return rejectedOutcome(group, "target-provider-association-already-exists");
      }
      if (entityOwners.length !== 1) {
        return rejectedOutcome(group, "owner-count-not-one");
      }

      const owner = entityOwners[0]!;
      if (owner.segmentCount !== 0) {
        return rejectedOutcome(group, "existing-provider-segments");
      }

      const legacy = legacyByIdentity.get(identity);
      if (!legacy) return rejectedOutcome(group, "missing-legacy-parent");
      if (legacy.animeId !== owner.animeId) {
        return rejectedOutcome(group, "legacy-parent-owner-mismatch");
      }

      const evidence = await getSeasonEvidence(group.provider, group.providerId);
      const authoritativeIds = new Set(
        evidence.episodes.map((episode) => episode.providerEpisodeId),
      );

      const targetProviderRows =
        episodeRowsByAnimeProvider.get(animeProviderKey(group.animeId, group.provider)) ?? [];
      if (targetProviderRows.some((row) => !authoritativeIds.has(row.providerEpisodeId))) {
        return rejectedOutcome(group, "target-provider-scope-mismatch");
      }
      const ownerProviderRows =
        episodeRowsByAnimeProvider.get(animeProviderKey(owner.animeId, group.provider)) ?? [];
      if (ownerProviderRows.some((row) => !authoritativeIds.has(row.providerEpisodeId))) {
        return rejectedOutcome(group, "owner-provider-scope-mismatch");
      }

      const mappedEpisodes: WholeSeasonMappedEpisode[] = [];
      for (const episode of evidence.episodes) {
        const mapping = episodeByProviderIdentity.get(
          episodeIdentityKey(group.provider, episode.providerEpisodeId),
        );
        if (!mapping) continue;
        mappedEpisodes.push({
          providerEpisodeId: episode.providerEpisodeId,
          animeId: mapping.animeId,
          localEpisodeNumber: mapping.localEpisodeNumber,
          localKind: mapping.localKind,
        });
      }

      const targetLocalEpisodes = localEpisodesByAnime.get(group.animeId) ?? [];
      const ownerLocalEpisodes = localEpisodesByAnime.get(owner.animeId) ?? [];
      const structural = planWholeSeasonOwnershipRepair({
        targetAnimeId: group.animeId,
        currentOwnerAnimeId: owner.animeId,
        authoritativeEpisodes: evidence.episodes,
        mappedEpisodes,
        targetNormalEpisodeNumbers: targetLocalEpisodes
          .filter((episode) => episode.kind === "normal")
          .map((episode) => episode.episodeNumber),
        ownerNormalEpisodeCount: ownerLocalEpisodes.filter((episode) => episode.kind === "normal")
          .length,
      });
      if (!structural.candidate) return rejectedOutcome(group, structural.reason!);

      const targetMeta = metaByAnime.get(group.animeId);
      if (!targetMeta) return rejectedOutcome(group, "missing-target-metadata");

      const providerTitles = await getProviderTitles(group.provider, group.providerId);
      const identityVerification = verifyProviderSeasonIdentity({
        anime: targetMeta,
        authoritativeEpisodeCount: structural.candidate.authoritativeEpisodeCount,
        providerTitles,
      });
      if (!identityVerification.ok) {
        return rejectedOutcome(group, identityVerification.reason!);
      }

      const airdate = verifyProviderSeasonAirdate({
        targetStartDate: targetMeta.startDate,
        providerFirstAirDate: evidence.firstAirDate,
      });
      if (!airdate.ok) return rejectedOutcome(group, airdate.reason!);

      const mappedTransferRows = evidence.episodes
        .map((episode) =>
          episodeByProviderIdentity.get(
            episodeIdentityKey(group.provider, episode.providerEpisodeId),
          ),
        )
        .filter((row): row is EpisodeMappingRow => Boolean(row))
        .map((row) => ({
          episodeMappingId: row.episodeMappingId,
          providerEpisodeId: row.providerEpisodeId,
          animeId: row.animeId,
          episodeId: row.episodeId,
        }));

      const transfer = planEpisodeOwnershipTransfers({
        currentOwnerAnimeId: owner.animeId,
        targetAnimeId: group.animeId,
        providerEpisodeNumbersToMove: structural.candidate.providerEpisodeNumbersToMove,
        authoritativeEpisodes: evidence.episodes,
        mappedEpisodes: mappedTransferRows,
        targetEpisodes: targetLocalEpisodes.map((episode) => ({
          episodeId: episode.episodeId,
          episodeNumber: episode.episodeNumber,
          kind: episode.kind,
          hasProviderMapping: episodeProviderSlots.has(
            `${episode.episodeId}\u0000${group.provider}`,
          ),
        })),
      });
      if (!transfer.moves) return rejectedOutcome(group, transfer.reason!);

      const ownerMeta = metaByAnime.get(owner.animeId);
      return {
        group,
        reason: null,
        candidate: {
          provider: group.provider,
          providerId: group.providerId,
          providerEntityId: owner.providerEntityId,
          animeProviderMappingId: owner.animeProviderMappingId,
          legacyMappingId: legacy.legacyMappingId,
          targetAnimeId: group.animeId,
          currentOwnerAnimeId: owner.animeId,
          targetTitle: targetMeta.titleRomaji,
          currentOwnerTitle: ownerMeta?.titleRomaji ?? null,
          authoritativeEpisodeCount: structural.candidate.authoritativeEpisodeCount,
          orphanRowsResolved: group.rows.length,
          episodeMoves: transfer.moves,
          providerFirstAirDate: airdate.providerFirstAirDate!,
          startDateDeltaDays: airdate.startDateDeltaDays!,
          bestTitleSimilarity: identityVerification.bestTitleSimilarity,
        },
      };
    },
  );

  const candidates: RepairCandidate[] = [];
  const rejectionCounts = new Map<string, number>();
  const rejectedSamples: RejectedSample[] = [];
  for (const outcome of outcomes) {
    if (outcome.reason) {
      increment(rejectionCounts, outcome.reason);
      if (rejectedSamples.length < 100) {
        rejectedSamples.push({
          animeId: outcome.group.animeId,
          provider: outcome.group.provider,
          providerId: outcome.group.providerId,
          reason: outcome.reason,
        });
      }
    } else if (outcome.candidate) {
      candidates.push(outcome.candidate);
    }
  }

  candidates.sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.providerId.localeCompare(b.providerId) ||
      a.targetAnimeId - b.targetAnimeId,
  );

  uniqueIds(candidates.map((candidate) => candidate.legacyMappingId), "legacy mapping IDs");
  uniqueIds(candidates.map((candidate) => candidate.animeProviderMappingId), "v2 mapping IDs");
  uniqueIds(
    candidates.flatMap((candidate) => candidate.episodeMoves.map((move) => move.episodeMappingId)),
    "episode mapping IDs",
  );

  rejectedSamples.sort(
    (a, b) =>
      a.reason.localeCompare(b.reason) ||
      a.provider.localeCompare(b.provider) ||
      a.animeId - b.animeId,
  );

  return {
    resolvedCollisionGroups: resolvedGroups.length,
    candidates,
    rejectedByReason: Object.fromEntries(
      [...rejectionCounts.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
    rejectedSamples,
  };
}

function episodeMoveValues(candidates: RepairCandidate[]): SQL[] {
  return candidates.flatMap((candidate) =>
    candidate.episodeMoves.map((move) => sql`(
      ${move.episodeMappingId}::int,
      ${move.fromEpisodeId}::int,
      ${move.toEpisodeId}::int,
      ${candidate.provider}::text,
      ${move.providerEpisodeId}::text
    )`),
  );
}

function parentTransferValues(candidates: RepairCandidate[]): SQL[] {
  return candidates.map((candidate) => sql`(
    ${candidate.legacyMappingId}::int,
    ${candidate.currentOwnerAnimeId}::int,
    ${candidate.targetAnimeId}::int,
    ${candidate.provider}::text,
    ${candidate.providerId}::text
  )`);
}

function v2TransferValues(candidates: RepairCandidate[]): SQL[] {
  return candidates.map((candidate) => sql`(
    ${candidate.animeProviderMappingId}::int,
    ${candidate.providerEntityId}::int,
    ${candidate.currentOwnerAnimeId}::int,
    ${candidate.targetAnimeId}::int,
    ${candidate.provider}::text
  )`);
}

async function verifyExpectedState(
  executeSql: ExecuteSql,
  candidates: RepairCandidate[],
): Promise<{
  wrongEpisodeMoves: number;
  wrongLegacyParents: number;
  wrongV2Associations: number;
  transferredAssociationsWithSegments: number;
}> {
  if (candidates.length === 0) {
    return {
      wrongEpisodeMoves: 0,
      wrongLegacyParents: 0,
      wrongV2Associations: 0,
      transferredAssociationsWithSegments: 0,
    };
  }

  const runCount = async (query: SQL): Promise<number> => {
    const result = await executeSql(query);
    const rows = [...(result as Iterable<Record<string, unknown>>)] as CountRow[];
    return Number(rows[0]?.count ?? 0);
  };

  const episodeValues = candidates.flatMap((candidate) =>
    candidate.episodeMoves.map(
      (move) => sql`(${move.episodeMappingId}::int, ${move.toEpisodeId}::int)`,
    ),
  );
  const legacyValues = candidates.map(
    (candidate) => sql`(${candidate.legacyMappingId}::int, ${candidate.targetAnimeId}::int)`,
  );
  const v2Values = candidates.map(
    (candidate) =>
      sql`(${candidate.animeProviderMappingId}::int, ${candidate.targetAnimeId}::int)`,
  );
  const mappingIds = candidates.map((candidate) => candidate.animeProviderMappingId);

  const wrongEpisodeMoves =
    episodeValues.length === 0
      ? 0
      : await runCount(sql`
          with expected(id, episode_id) as (values ${sql.join(episodeValues, sql`, `)})
          select count(*)::int as count
          from expected
          where not exists (
            select 1
            from public.episode_mappings em
            where em.id = expected.id
              and em.episode_id = expected.episode_id
          )
        `);

  const wrongLegacyParents = await runCount(sql`
    with expected(id, anime_id) as (values ${sql.join(legacyValues, sql`, `)})
    select count(*)::int as count
    from expected
    where not exists (
      select 1
      from public.anime_mappings am
      where am.id = expected.id
        and am.anime_id = expected.anime_id
        and am.source = 'system'
        and am.confidence >= 95
    )
  `);

  const wrongV2Associations = await runCount(sql`
    with expected(id, anime_id) as (values ${sql.join(v2Values, sql`, `)})
    select count(*)::int as count
    from expected
    where not exists (
      select 1
      from public.anime_provider_mappings apm
      where apm.id = expected.id
        and apm.anime_id = expected.anime_id
        and apm.source = 'system'
        and apm.confidence >= 95
    )
  `);

  const transferredAssociationsWithSegments = await runCount(sql`
    select count(*)::int as count
    from public.anime_provider_segments aps
    where aps.anime_provider_mapping_id in (
      ${sql.join(mappingIds.map((id) => sql`${id}`), sql`, `)}
    )
  `);

  return {
    wrongEpisodeMoves,
    wrongLegacyParents,
    wrongV2Associations,
    transferredAssociationsWithSegments,
  };
}

async function applyCandidates(candidates: RepairCandidate[]): Promise<{
  episodeMappingsMoved: number;
  legacyParentsTransferred: number;
  v2AssociationsTransferred: number;
}> {
  if (candidates.length === 0) {
    return {
      episodeMappingsMoved: 0,
      legacyParentsTransferred: 0,
      v2AssociationsTransferred: 0,
    };
  }

  const plannedEpisodeMoves = candidates.reduce(
    (total, candidate) => total + candidate.episodeMoves.length,
    0,
  );

  return db.transaction(async (tx) => {
    const episodeValues = episodeMoveValues(candidates);
    const episodeRows =
      episodeValues.length === 0
        ? []
        : await transactionRows<{ id: number }>(tx, sql`
            with moves(id, from_episode_id, to_episode_id, provider, provider_id) as (
              values ${sql.join(episodeValues, sql`, `)}
            )
            update public.episode_mappings em
            set
              episode_id = moves.to_episode_id,
              updated_at = now()
            from moves
            where em.id = moves.id
              and em.episode_id = moves.from_episode_id
              and em.provider = moves.provider
              and em.provider_id = moves.provider_id
            returning em.id
          `);

    const legacyValues = parentTransferValues(candidates);
    const legacyRows = await transactionRows<{ id: number }>(tx, sql`
      with transfers(id, from_anime_id, to_anime_id, provider, provider_id) as (
        values ${sql.join(legacyValues, sql`, `)}
      )
      update public.anime_mappings am
      set
        anime_id = transfers.to_anime_id,
        source = 'system',
        confidence = greatest(am.confidence, 95),
        updated_at = now()
      from transfers
      where am.id = transfers.id
        and am.anime_id = transfers.from_anime_id
        and am.provider = transfers.provider
        and am.provider_id = transfers.provider_id
        and not exists (
          select 1
          from public.anime_mappings target
          where target.anime_id = transfers.to_anime_id
            and target.provider = transfers.provider
        )
      returning am.id
    `);

    const v2Values = v2TransferValues(candidates);
    const v2Rows = await transactionRows<{ id: number }>(tx, sql`
      with transfers(id, provider_entity_id, from_anime_id, to_anime_id, provider) as (
        values ${sql.join(v2Values, sql`, `)}
      )
      update public.anime_provider_mappings apm
      set
        anime_id = transfers.to_anime_id,
        source = 'system',
        confidence = greatest(apm.confidence, 95),
        updated_at = now()
      from transfers
      where apm.id = transfers.id
        and apm.provider_entity_id = transfers.provider_entity_id
        and apm.anime_id = transfers.from_anime_id
        and not exists (
          select 1
          from public.anime_provider_segments aps
          where aps.anime_provider_mapping_id = apm.id
        )
        and not exists (
          select 1
          from public.anime_provider_mappings target
          join public.provider_entities target_pe
            on target_pe.id = target.provider_entity_id
          where target.anime_id = transfers.to_anime_id
            and target_pe.provider = transfers.provider
        )
      returning apm.id
    `);

    if (episodeRows.length !== plannedEpisodeMoves) {
      throw new Error(
        `Ownership repair planned ${plannedEpisodeMoves} episode mapping moves but updated ${episodeRows.length}; transaction rolled back`,
      );
    }
    if (legacyRows.length !== candidates.length) {
      throw new Error(
        `Ownership repair planned ${candidates.length} legacy parent transfers but updated ${legacyRows.length}; transaction rolled back`,
      );
    }
    if (v2Rows.length !== candidates.length) {
      throw new Error(
        `Ownership repair planned ${candidates.length} v2 association transfers but updated ${v2Rows.length}; transaction rolled back`,
      );
    }

    const verified = await verifyExpectedState((query) => tx.execute(query), candidates);
    if (
      verified.wrongEpisodeMoves !== 0 ||
      verified.wrongLegacyParents !== 0 ||
      verified.wrongV2Associations !== 0 ||
      verified.transferredAssociationsWithSegments !== 0
    ) {
      throw new Error(
        `Ownership repair verification failed inside transaction: ${JSON.stringify(verified)}; transaction rolled back`,
      );
    }

    return {
      episodeMappingsMoved: episodeRows.length,
      legacyParentsTransferred: legacyRows.length,
      v2AssociationsTransferred: v2Rows.length,
    };
  });
}

async function run(mode: Mode): Promise<Record<string, unknown>> {
  const plan = await buildRepairPlan();
  const plannedEpisodeMappingReassignments = plan.candidates.reduce(
    (total, candidate) => total + candidate.episodeMoves.length,
    0,
  );
  const plannedOrphanRowsResolved = plan.candidates.reduce(
    (total, candidate) => total + candidate.orphanRowsResolved,
    0,
  );
  const byProvider = new Map<Provider, { groups: number; episodeMoves: number }>([
    ["thetvdb", { groups: 0, episodeMoves: 0 }],
    ["tmdb", { groups: 0, episodeMoves: 0 }],
  ]);
  for (const candidate of plan.candidates) {
    const summary = byProvider.get(candidate.provider)!;
    summary.groups += 1;
    summary.episodeMoves += candidate.episodeMoves.length;
  }

  let applied = {
    episodeMappingsMoved: 0,
    legacyParentsTransferred: 0,
    v2AssociationsTransferred: 0,
  };
  if (mode === "apply") {
    applied = await applyCandidates(plan.candidates);
    const postCommit = await verifyExpectedState((query) => db.execute(query), plan.candidates);
    if (
      postCommit.wrongEpisodeMoves !== 0 ||
      postCommit.wrongLegacyParents !== 0 ||
      postCommit.wrongV2Associations !== 0 ||
      postCommit.transferredAssociationsWithSegments !== 0
    ) {
      throw new Error(
        `Ownership repair post-commit verification failed: ${JSON.stringify(postCommit)}`,
      );
    }
  }

  return {
    ok: true,
    mode,
    generatedAt: new Date().toISOString(),
    operation: {
      code: "repair-provider-season-ownership",
      description:
        "Transfer only whole TVDB/TMDB seasons whose ownership is proven by complete authoritative provider episode coverage, exact AniList episode count, strong provider-title identity, aligned provider/AniList start dates, isolated provider scope, and an unsegmented one-to-one v2 association. Dry-run is the default. Apply mode moves only the incorrectly owned provider episode mappings, transfers the legacy parent and v2 association to the verified target, marks the repaired parent associations as system-verified at confidence >=95, and verifies exact writes inside one transaction before commit.",
      resolvedCollisionGroups: plan.resolvedCollisionGroups,
      safeWholeSeasonTransferGroups: plan.candidates.length,
      plannedEpisodeMappingReassignments,
      plannedLegacyParentTransfers: plan.candidates.length,
      plannedV2AssociationTransfers: plan.candidates.length,
      plannedOrphanEpisodeMappingsResolved: plannedOrphanRowsResolved,
      appliedEpisodeMappingReassignments: applied.episodeMappingsMoved,
      appliedLegacyParentTransfers: applied.legacyParentsTransferred,
      appliedV2AssociationTransfers: applied.v2AssociationsTransferred,
      byProvider: Object.fromEntries(byProvider.entries()),
      rejectedByReason: plan.rejectedByReason,
      candidateSamples: plan.candidates.slice(0, 60).map((candidate) => ({
        provider: candidate.provider,
        providerId: candidate.providerId,
        targetAnimeId: candidate.targetAnimeId,
        targetTitle: candidate.targetTitle,
        currentOwnerAnimeId: candidate.currentOwnerAnimeId,
        currentOwnerTitle: candidate.currentOwnerTitle,
        authoritativeEpisodeCount: candidate.authoritativeEpisodeCount,
        orphanRowsResolved: candidate.orphanRowsResolved,
        episodeMappingsToMove: candidate.episodeMoves.length,
        providerEpisodeNumbersToMove: candidate.episodeMoves.map(
          (move) => move.providerEpisodeNumber,
        ),
        providerFirstAirDate: candidate.providerFirstAirDate,
        startDateDeltaDays: candidate.startDateDeltaDays,
        bestTitleSimilarity: candidate.bestTitleSimilarity,
      })),
      rejectedSamples: plan.rejectedSamples,
    },
  };
}

if (import.meta.main) {
  const { mode } = parseRepairMappingsArgs(Bun.argv.slice(2));
  let lease: SyncLease | null = null;
  let succeeded = false;

  try {
    if (mode === "apply") {
      lease = await tryAcquireSyncLease();
      if (!lease) {
        throw new Error(
          "Another AniCore sync process already holds the database lease; ownership repair was not started",
        );
      }
    }

    const report = await run(mode);
    console.log(JSON.stringify(report, null, 2));
    succeeded = true;
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          mode,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    if (lease) {
      try {
        await lease.release(succeeded);
      } catch (error) {
        console.error(
          `Failed to release provider season ownership repair lease: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exitCode = 1;
      }
    }
    await closeDb().catch(() => undefined);
  }
}
