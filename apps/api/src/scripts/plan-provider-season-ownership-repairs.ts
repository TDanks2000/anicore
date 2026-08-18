import { TMDB } from "@api-wrappers/tmdb-wrapper";
import { sql, type SQL } from "drizzle-orm";

import { closeDb, db } from "@anicore/db";
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
  verifyProviderSeasonIdentity,
  type ProviderSeasonIdentityRejectReason,
  type ProviderSeasonIdentityResult,
} from "./provider-season-identity-verification";
import {
  planWholeSeasonOwnershipRepair,
  type WholeSeasonAuthoritativeEpisode,
  type WholeSeasonMappedEpisode,
  type WholeSeasonRepairRejectReason,
} from "./whole-season-ownership-repair-plan";

type Provider = "thetvdb" | "tmdb";

type PlanningRejectReason =
  | WholeSeasonRepairRejectReason
  | ProviderSeasonIdentityRejectReason
  | "missing-provider-entity"
  | "owner-count-not-one"
  | "target-association-already-exists"
  | "missing-target-metadata";

interface ProviderEntityMappingRow {
  providerEntityId: number;
  provider: Provider;
  providerId: string;
  animeProviderMappingId: number;
  animeId: number;
  confidence: number;
  source: string;
  isPrimary: boolean;
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
  titleEnglish: string | null;
  titleNative: string | null;
  titleUserPreferred: string | null;
  synonymsJson: string;
  format: string | null;
  episodeCount: number | null;
}

interface CandidateSample {
  provider: Provider;
  providerId: string;
  providerEntityId: number;
  targetAnimeId: number;
  targetTitle: string | null;
  targetFormat: string | null;
  targetMetadataEpisodeCount: number | null;
  currentOwnerAnimeId: number;
  currentOwnerTitle: string | null;
  currentOwnerFormat: string | null;
  currentOwnerMetadataEpisodeCount: number | null;
  currentOwnerMappingSource: string;
  currentOwnerMappingConfidence: number;
  authoritativeEpisodeCount: number;
  targetOwnedEpisodeCount: number;
  ownerOwnedEpisodeCount: number;
  providerEpisodeNumbersToMove: number[];
  providerTitles: string[];
  bestProviderTitle: string | null;
  bestTargetTitle: string | null;
  bestTitleSimilarity: number;
}

interface RejectedSample {
  animeId: number;
  provider: Provider;
  providerId: string;
  reason: PlanningRejectReason;
}

interface PlanningOutcome {
  group: ResolvedCollisionGroup;
  owner: ProviderEntityMappingRow | null;
  plan: ReturnType<typeof planWholeSeasonOwnershipRepair> | null;
  structurallySafe: boolean;
  reason: PlanningRejectReason | null;
  identity: ProviderSeasonIdentityResult | null;
}

async function queryRows<T extends Record<string, unknown>>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as T[];
}

function identityKey(provider: string, providerId: string): string {
  return `${provider}\u0000${providerId}`;
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
      pe.id as "providerEntityId",
      pe.provider,
      pe.provider_id as "providerId",
      apm.id as "animeProviderMappingId",
      apm.anime_id as "animeId",
      apm.confidence,
      apm.source,
      apm.is_primary as "isPrimary"
    from public.provider_entities pe
    join public.anime_provider_mappings apm
      on apm.provider_entity_id = pe.id
    where pe.provider in ('thetvdb', 'tmdb')
    order by pe.provider, pe.provider_id, apm.anime_id
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
      title_english as "titleEnglish",
      title_native as "titleNative",
      title_user_preferred as "titleUserPreferred",
      synonyms_json as "synonymsJson",
      format,
      episode_count as "episodeCount"
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

function tvdbAuthoritativeEpisodes(
  episodes: TvdbEpisodeBase[],
): WholeSeasonAuthoritativeEpisode[] {
  return episodes
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
    .sort((a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber);
}

async function resolveTvdbGroups(
  rows: CollisionEpisodeMappingRow[],
  authoritativeCache: Map<string, Promise<WholeSeasonAuthoritativeEpisode[]>>,
): Promise<ResolvedCollisionGroup[]> {
  const groupPlan = buildTvdbSlugResolutionGroups(rows);
  const rowsByAnime = new Map<number, CollisionEpisodeMappingRow[]>();
  for (const row of rows) {
    if (row.provider !== "thetvdb") continue;
    const group = rowsByAnime.get(row.animeId) ?? [];
    group.push(row);
    rowsByAnime.set(row.animeId, group);
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
      authoritativeCache.set(
        identityKey("thetvdb", verified.providerId),
        Promise.resolve(tvdbAuthoritativeEpisodes(season)),
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
  const [orphanRows, entityMappings, episodeRows, localNormalRows, animeMetaRows] =
    await Promise.all([
      loadNormalOrphanRows(),
      loadProviderEntityMappings(),
      loadEpisodeMappings(),
      loadLocalNormalEpisodes(),
      loadAnimeMeta(),
    ]);

  if (orphanRows.some((row) => row.provider === "thetvdb") && !process.env.TVDB_API_KEY?.trim()) {
    throw new Error("TVDB_API_KEY is required for provider ownership repair planning");
  }
  if (orphanRows.some((row) => row.provider === "tmdb") && !process.env.TMDB_API_KEY?.trim()) {
    throw new Error("TMDB_API_KEY is required for provider ownership repair planning");
  }

  const authoritativeCache = new Map<
    string,
    Promise<WholeSeasonAuthoritativeEpisode[]>
  >();
  const tmdbPlan = buildTmdbResolvedCollisionGroups(orphanRows);
  const tvdbGroups = await resolveTvdbGroups(orphanRows, authoritativeCache);
  const resolvedGroups = [...tmdbPlan.groups, ...tvdbGroups];

  const mappingsByEntity = new Map<string, ProviderEntityMappingRow[]>();
  for (const row of entityMappings) {
    const key = identityKey(row.provider, row.providerId);
    const list = mappingsByEntity.get(key) ?? [];
    list.push(row);
    mappingsByEntity.set(key, list);
  }

  const episodeMap = new Map<string, EpisodeMappingRow>();
  for (const row of episodeRows) {
    episodeMap.set(episodeIdentityKey(row.provider, row.providerEpisodeId), row);
  }

  const localNormalsByAnime = new Map<number, number[]>();
  for (const row of localNormalRows) {
    const list = localNormalsByAnime.get(row.animeId) ?? [];
    list.push(row.episodeNumber);
    localNormalsByAnime.set(row.animeId, list);
  }
  const metaByAnime = new Map(animeMetaRows.map((row) => [row.animeId, row]));

  let tmdb: TMDB | null = null;
  const getTmdb = (): TMDB => {
    if (!tmdb) {
      const apiKey = process.env.TMDB_API_KEY?.trim();
      if (!apiKey) throw new Error("TMDB_API_KEY is required");
      tmdb = new TMDB({ apiKey });
    }
    return tmdb;
  };

  const getAuthoritativeSeason = (
    provider: Provider,
    providerId: string,
  ): Promise<WholeSeasonAuthoritativeEpisode[]> => {
    const key = identityKey(provider, providerId);
    const cached = authoritativeCache.get(key);
    if (cached) return cached;
    const parsed = parseProviderIdentity(providerId);
    if (!parsed) throw new Error(`Malformed ${provider} provider ID: ${providerId}`);
    const promise =
      provider === "thetvdb"
        ? getTvdbSeasonEpisodes(parsed.entityId, parsed.seasonNumber, "eng").then(
            tvdbAuthoritativeEpisodes,
          )
        : getTmdb()
            .tvSeasons.details(
              { tvShowID: parsed.entityId, seasonNumber: parsed.seasonNumber },
              undefined,
              { language: "en-US" },
            )
            .then((season) =>
              (season.episodes ?? [])
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
            );
    authoritativeCache.set(key, promise);
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

  const rejectionCounts = new Map<string, number>();
  const rejectedSamples: RejectedSample[] = [];
  const candidateSamples: CandidateSample[] = [];
  let structurallySafeWholeSeasonTransferGroups = 0;
  let safeWholeSeasonTransferGroups = 0;
  let plannedEpisodeMappingReassignments = 0;
  let plannedLegacyParentTransfers = 0;
  let plannedV2AssociationTransfers = 0;
  const byProvider = new Map<Provider, { groups: number; episodeMoves: number }>([
    ["thetvdb", { groups: 0, episodeMoves: 0 }],
    ["tmdb", { groups: 0, episodeMoves: 0 }],
  ]);

  const outcomes = await mapWithConcurrency<ResolvedCollisionGroup, PlanningOutcome>(
    resolvedGroups,
    5,
    async (group) => {
      const key = identityKey(group.provider, group.providerId);
      const mappings = mappingsByEntity.get(key);
      if (!mappings || mappings.length === 0) {
        return {
          group,
          owner: null,
          plan: null,
          structurallySafe: false,
          reason: "missing-provider-entity",
          identity: null,
        };
      }
      if (mappings.some((mapping) => mapping.animeId === group.animeId)) {
        return {
          group,
          owner: null,
          plan: null,
          structurallySafe: false,
          reason: "target-association-already-exists",
          identity: null,
        };
      }
      const owners = mappings.filter((mapping) => mapping.animeId !== group.animeId);
      if (owners.length !== 1) {
        return {
          group,
          owner: null,
          plan: null,
          structurallySafe: false,
          reason: "owner-count-not-one",
          identity: null,
        };
      }

      const owner = owners[0]!;
      const authoritative = await getAuthoritativeSeason(group.provider, group.providerId);
      const mappedEpisodes: WholeSeasonMappedEpisode[] = [];
      for (const episode of authoritative) {
        const mapping = episodeMap.get(
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

      const plan = planWholeSeasonOwnershipRepair({
        targetAnimeId: group.animeId,
        currentOwnerAnimeId: owner.animeId,
        authoritativeEpisodes: authoritative,
        mappedEpisodes,
        targetNormalEpisodeNumbers: localNormalsByAnime.get(group.animeId) ?? [],
        ownerNormalEpisodeCount: (localNormalsByAnime.get(owner.animeId) ?? []).length,
      });
      if (!plan.candidate) {
        return {
          group,
          owner,
          plan,
          structurallySafe: false,
          reason: plan.reason,
          identity: null,
        };
      }

      const targetMeta = metaByAnime.get(group.animeId);
      if (!targetMeta) {
        return {
          group,
          owner,
          plan,
          structurallySafe: true,
          reason: "missing-target-metadata",
          identity: null,
        };
      }

      const providerTitles = await getProviderTitles(group.provider, group.providerId);
      const identity = verifyProviderSeasonIdentity({
        anime: targetMeta,
        authoritativeEpisodeCount: plan.candidate.authoritativeEpisodeCount,
        providerTitles,
      });
      return {
        group,
        owner,
        plan,
        structurallySafe: true,
        reason: identity.reason,
        identity,
      };
    },
  );

  for (const outcome of outcomes) {
    const { group, owner, plan, structurallySafe, reason, identity } = outcome;
    if (structurallySafe) structurallySafeWholeSeasonTransferGroups += 1;

    if (!plan?.candidate || !owner || reason) {
      const rejectReason = reason ?? "owner-count-not-one";
      increment(rejectionCounts, rejectReason);
      if (rejectedSamples.length < 50) {
        rejectedSamples.push({
          animeId: group.animeId,
          provider: group.provider,
          providerId: group.providerId,
          reason: rejectReason,
        });
      }
      continue;
    }

    const candidate = plan.candidate;
    safeWholeSeasonTransferGroups += 1;
    plannedEpisodeMappingReassignments += candidate.ownerOwnedEpisodeCount;
    plannedLegacyParentTransfers += 1;
    plannedV2AssociationTransfers += 1;
    const providerSummary = byProvider.get(group.provider)!;
    providerSummary.groups += 1;
    providerSummary.episodeMoves += candidate.ownerOwnedEpisodeCount;

    if (candidateSamples.length < 60) {
      const targetMeta = metaByAnime.get(group.animeId)!;
      const ownerMeta = metaByAnime.get(owner.animeId);
      candidateSamples.push({
        provider: group.provider,
        providerId: group.providerId,
        providerEntityId: owner.providerEntityId,
        targetAnimeId: group.animeId,
        targetTitle: targetMeta.titleRomaji,
        targetFormat: targetMeta.format,
        targetMetadataEpisodeCount: targetMeta.episodeCount,
        currentOwnerAnimeId: owner.animeId,
        currentOwnerTitle: ownerMeta?.titleRomaji ?? null,
        currentOwnerFormat: ownerMeta?.format ?? null,
        currentOwnerMetadataEpisodeCount: ownerMeta?.episodeCount ?? null,
        currentOwnerMappingSource: owner.source,
        currentOwnerMappingConfidence: owner.confidence,
        authoritativeEpisodeCount: candidate.authoritativeEpisodeCount,
        targetOwnedEpisodeCount: candidate.targetOwnedEpisodeCount,
        ownerOwnedEpisodeCount: candidate.ownerOwnedEpisodeCount,
        providerEpisodeNumbersToMove: candidate.providerEpisodeNumbersToMove,
        providerTitles: identity?.providerTitles ?? [],
        bestProviderTitle: identity?.bestProviderTitle ?? null,
        bestTargetTitle: identity?.bestTargetTitle ?? null,
        bestTitleSimilarity: identity?.bestTitleSimilarity ?? 0,
      });
    }
  }

  candidateSamples.sort(
    (a, b) =>
      b.authoritativeEpisodeCount - a.authoritativeEpisodeCount ||
      a.provider.localeCompare(b.provider) ||
      a.targetAnimeId - b.targetAnimeId,
  );
  rejectedSamples.sort(
    (a, b) =>
      a.reason.localeCompare(b.reason) ||
      a.provider.localeCompare(b.provider) ||
      a.animeId - b.animeId,
  );

  return {
    ok: true,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    operation: {
      code: "plan-provider-season-ownership-repairs",
      description:
        "Plan only strict whole-season ownership repairs where one orphan AniCore anime has a complete 1..N local season matching the authoritative TVDB/TMDB season, already owns a strict majority of exact provider episodes number-for-number, and the current parent owner accounts for exactly the missing provider episodes. Structural candidates are additionally required to have an exact AniList metadata episode count and a strong canonical provider-title match against AniList titles/synonyms before they are reported as safe. This command never writes data.",
      resolvedCollisionGroups: resolvedGroups.length,
      structurallySafeWholeSeasonTransferGroups,
      safeWholeSeasonTransferGroups,
      plannedEpisodeMappingReassignments,
      plannedLegacyParentTransfers,
      plannedV2AssociationTransfers,
      byProvider: Object.fromEntries(byProvider.entries()),
      rejectedByReason: Object.fromEntries(
        [...rejectionCounts.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      candidateSamples,
      rejectedSamples,
    },
  };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length > 0) {
      throw new Error(
        `This command is planning-only and accepts no arguments; received: ${args.join(" ")}`,
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
