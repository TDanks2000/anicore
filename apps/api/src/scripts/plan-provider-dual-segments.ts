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
  buildDualProviderSegmentPlan,
  type AlignedProviderSegment,
  type ProviderEpisodeAlignmentRow,
} from "./dual-provider-segment-plan";
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
  classifyProviderSeasonOwnership,
  type ProviderSeasonEpisodeOwnership,
} from "./provider-season-ownership-diagnostics";

type Provider = "thetvdb" | "tmdb";
type AdjacentClassification =
  | "owner-then-orphan-adjacent"
  | "orphan-then-owner-adjacent";

type RejectReason =
  | "not-adjacent-ownership"
  | "missing-provider-entity"
  | "owner-count-not-one"
  | "existing-segments-present"
  | "orphan-association-already-exists"
  | "multiple-safe-orphans-for-entity"
  | "empty-episode-range"
  | "non-normal-local-episode"
  | "invalid-episode-number"
  | "duplicate-provider-episode-number"
  | "duplicate-local-episode-number"
  | "non-contiguous-provider-range"
  | "non-contiguous-local-range"
  | "non-linear-local-alignment"
  | "segment-order-mismatch";

interface ProviderEntityMappingRow {
  providerEntityId: number;
  provider: Provider;
  providerId: string;
  animeProviderMappingId: number;
  animeId: number;
}

interface EpisodeMappingAlignmentRow {
  animeId: number;
  provider: Provider;
  providerEpisodeId: string;
  localEpisodeNumber: number;
  localKind: string;
}

interface ExistingSegmentRow {
  providerEntityId: number;
  segmentId: number;
}

interface AuthoritativeEpisode {
  providerEpisodeId: string;
  providerEpisodeNumber: number;
}

interface PreliminaryCandidate {
  animeId: number;
  provider: Provider;
  providerId: string;
  providerEntityId: number;
  ownerAnimeId: number;
  ownerAnimeProviderMappingId: number;
  classification: AdjacentClassification;
  confidence: number;
  ownerSegment: AlignedProviderSegment;
  orphanSegment: AlignedProviderSegment;
}

interface CandidateSample extends PreliminaryCandidate {
  plannedOrphanSource: "fuzzy";
  plannedOrphanIsPrimary: false;
}

interface RejectedSample {
  animeId: number;
  provider: Provider;
  providerId: string;
  reason: RejectReason;
}

interface GroupOutcome {
  group: ResolvedCollisionGroup;
  adjacent: boolean;
  candidate: PreliminaryCandidate | null;
  reason: RejectReason | null;
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
      apm.anime_id as "animeId"
    from public.provider_entities pe
    join public.anime_provider_mappings apm
      on apm.provider_entity_id = pe.id
    where pe.provider in ('thetvdb', 'tmdb')
    order by pe.provider, pe.provider_id, apm.anime_id
  `);
}

async function loadEpisodeAlignmentRows(): Promise<EpisodeMappingAlignmentRow[]> {
  return queryRows<EpisodeMappingAlignmentRow>(sql`
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

async function loadExistingSegments(): Promise<ExistingSegmentRow[]> {
  return queryRows<ExistingSegmentRow>(sql`
    select
      apm.provider_entity_id as "providerEntityId",
      aps.id as "segmentId"
    from public.anime_provider_segments aps
    join public.anime_provider_mappings apm
      on apm.id = aps.anime_provider_mapping_id
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

function tvdbAuthoritativeEpisodes(episodes: TvdbEpisodeBase[]): AuthoritativeEpisode[] {
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
  authoritativeCache: Map<string, Promise<AuthoritativeEpisode[]>>,
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
    const cacheKey = slug.trim().toLowerCase();
    let promise = seriesCache.get(cacheKey);
    if (!promise) {
      promise = getTvdbSeriesBySlug(slug);
      seriesCache.set(cacheKey, promise);
    }
    return promise;
  };
  const getSeason = (seriesId: number, seasonNumber: number): Promise<TvdbEpisodeBase[]> => {
    const cacheKey = `${seriesId}:${seasonNumber}`;
    let promise = seasonCache.get(cacheKey);
    if (!promise) {
      promise = getTvdbSeasonEpisodes(seriesId, seasonNumber, "eng");
      seasonCache.set(cacheKey, promise);
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

function increment(
  map: Map<string, { groups: number }>,
  reason: string,
): void {
  const current = map.get(reason) ?? { groups: 0 };
  current.groups += 1;
  map.set(reason, current);
}

function incrementOffset(map: Map<string, number>, offset: number): void {
  const key = String(offset);
  map.set(key, (map.get(key) ?? 0) + 1);
}

async function run(): Promise<Record<string, unknown>> {
  const [orphanRows, entityMappings, episodeRows, existingSegments] = await Promise.all([
    loadNormalOrphanRows(),
    loadProviderEntityMappings(),
    loadEpisodeAlignmentRows(),
    loadExistingSegments(),
  ]);

  if (orphanRows.some((row) => row.provider === "thetvdb") && !process.env.TVDB_API_KEY?.trim()) {
    throw new Error("TVDB_API_KEY is required for dual segment planning");
  }
  if (orphanRows.some((row) => row.provider === "tmdb") && !process.env.TMDB_API_KEY?.trim()) {
    throw new Error("TMDB_API_KEY is required for dual segment planning");
  }

  const authoritativeCache = new Map<string, Promise<AuthoritativeEpisode[]>>();
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
  const episodeMap = new Map<string, EpisodeMappingAlignmentRow>();
  for (const row of episodeRows) {
    episodeMap.set(episodeIdentityKey(row.provider, row.providerEpisodeId), row);
  }
  const entitiesWithSegments = new Set(existingSegments.map((row) => row.providerEntityId));

  const tmdbKey = process.env.TMDB_API_KEY?.trim() ?? "";
  const tmdb = tmdbKey ? new TMDB({ apiKey: tmdbKey }) : null;
  const getAuthoritativeSeason = (
    provider: Provider,
    providerId: string,
  ): Promise<AuthoritativeEpisode[]> => {
    const key = identityKey(provider, providerId);
    const cached = authoritativeCache.get(key);
    if (cached) return cached;
    const parsed = parseProviderIdentity(providerId);
    if (!parsed) throw new Error(`Malformed ${provider} provider ID: ${providerId}`);

    let promise: Promise<AuthoritativeEpisode[]>;
    if (provider === "thetvdb") {
      promise = getTvdbSeasonEpisodes(parsed.entityId, parsed.seasonNumber, "eng").then(
        tvdbAuthoritativeEpisodes,
      );
    } else {
      if (!tmdb) throw new Error("TMDB_API_KEY is required for TMDB dual segment planning");
      promise = tmdb.tvSeasons
        .details(
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
    }
    authoritativeCache.set(key, promise);
    return promise;
  };

  const rejected: RejectedSample[] = [];
  const preliminary: PreliminaryCandidate[] = [];
  let adjacentOwnershipGroups = 0;

  const outcomes = await mapWithConcurrency<ResolvedCollisionGroup, GroupOutcome>(
    resolvedGroups,
    5,
    async (group) => {
      const entityKey = identityKey(group.provider, group.providerId);
      const mappings = mappingsByEntity.get(entityKey);
      if (!mappings || mappings.length === 0) {
        return {
          group,
          adjacent: false,
          candidate: null,
          reason: "missing-provider-entity",
        };
      }
      const orphanExisting = mappings.find((mapping) => mapping.animeId === group.animeId);
      if (orphanExisting) {
        return {
          group,
          adjacent: false,
          candidate: null,
          reason: "orphan-association-already-exists",
        };
      }
      const owners = mappings.filter((mapping) => mapping.animeId !== group.animeId);
      if (owners.length !== 1) {
        return {
          group,
          adjacent: false,
          candidate: null,
          reason: "owner-count-not-one",
        };
      }
      const owner = owners[0]!;
      if (entitiesWithSegments.has(owner.providerEntityId)) {
        return {
          group,
          adjacent: false,
          candidate: null,
          reason: "existing-segments-present",
        };
      }

      const authoritative = await getAuthoritativeSeason(group.provider, group.providerId);
      const ownership: ProviderSeasonEpisodeOwnership[] = authoritative.map((episode) => ({
        ...episode,
        animeId:
          episodeMap.get(
            episodeIdentityKey(group.provider, episode.providerEpisodeId),
          )?.animeId ?? null,
      }));
      const diagnostic = classifyProviderSeasonOwnership(
        ownership,
        group.animeId,
        [owner.animeId],
      );
      if (
        diagnostic.classification !== "owner-then-orphan-adjacent" &&
        diagnostic.classification !== "orphan-then-owner-adjacent"
      ) {
        return {
          group,
          adjacent: false,
          candidate: null,
          reason: "not-adjacent-ownership",
        };
      }

      const ownerRows: ProviderEpisodeAlignmentRow[] = [];
      const orphanAlignmentRows: ProviderEpisodeAlignmentRow[] = [];
      for (const episode of authoritative) {
        const row = episodeMap.get(
          episodeIdentityKey(group.provider, episode.providerEpisodeId),
        );
        if (!row) continue;
        const aligned: ProviderEpisodeAlignmentRow = {
          animeId: row.animeId,
          providerEpisodeId: episode.providerEpisodeId,
          providerEpisodeNumber: episode.providerEpisodeNumber,
          localEpisodeNumber: row.localEpisodeNumber,
          localKind: row.localKind,
        };
        if (row.animeId === owner.animeId) ownerRows.push(aligned);
        if (row.animeId === group.animeId) orphanAlignmentRows.push(aligned);
      }

      const dual = buildDualProviderSegmentPlan(
        diagnostic.classification,
        owner.animeId,
        ownerRows,
        group.animeId,
        orphanAlignmentRows,
      );
      if (!dual.ownerSegment || !dual.orphanSegment || dual.reason) {
        return {
          group,
          adjacent: true,
          candidate: null,
          reason: dual.reason ?? "segment-order-mismatch",
        };
      }

      return {
        group,
        adjacent: true,
        reason: null,
        candidate: {
          animeId: group.animeId,
          provider: group.provider,
          providerId: group.providerId,
          providerEntityId: owner.providerEntityId,
          ownerAnimeId: owner.animeId,
          ownerAnimeProviderMappingId: owner.animeProviderMappingId,
          classification: diagnostic.classification,
          confidence: Math.min(85, group.confidence),
          ownerSegment: dual.ownerSegment,
          orphanSegment: dual.orphanSegment,
        },
      };
    },
  );

  for (const outcome of outcomes) {
    if (outcome.adjacent) adjacentOwnershipGroups += 1;
    if (outcome.candidate) {
      preliminary.push(outcome.candidate);
    } else if (outcome.reason) {
      rejected.push({
        animeId: outcome.group.animeId,
        provider: outcome.group.provider,
        providerId: outcome.group.providerId,
        reason: outcome.reason,
      });
    }
  }

  const candidatesByEntity = new Map<number, PreliminaryCandidate[]>();
  for (const candidate of preliminary) {
    const list = candidatesByEntity.get(candidate.providerEntityId) ?? [];
    list.push(candidate);
    candidatesByEntity.set(candidate.providerEntityId, list);
  }
  const safe: PreliminaryCandidate[] = [];
  for (const list of candidatesByEntity.values()) {
    if (list.length === 1) {
      safe.push(list[0]!);
      continue;
    }
    for (const candidate of list) {
      rejected.push({
        animeId: candidate.animeId,
        provider: candidate.provider,
        providerId: candidate.providerId,
        reason: "multiple-safe-orphans-for-entity",
      });
    }
  }

  const rejectedByReason = new Map<string, { groups: number }>();
  for (const item of rejected) increment(rejectedByReason, item.reason);
  const ownerOffsetDistribution = new Map<string, number>();
  const orphanOffsetDistribution = new Map<string, number>();
  for (const candidate of safe) {
    incrementOffset(ownerOffsetDistribution, candidate.ownerSegment.offset);
    incrementOffset(orphanOffsetDistribution, candidate.orphanSegment.offset);
  }

  safe.sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.providerId.localeCompare(b.providerId) ||
      a.animeId - b.animeId,
  );

  const byProvider = Object.fromEntries(
    (["thetvdb", "tmdb"] as Provider[]).map((provider) => {
      const providerSafe = safe.filter((candidate) => candidate.provider === provider);
      return [
        provider,
        {
          safeDualSegmentGroups: providerSafe.length,
          plannedAssociations: providerSafe.length,
          plannedSegments: providerSafe.length * 2,
        },
      ];
    }),
  );

  const candidateSamples: CandidateSample[] = safe.slice(0, 40).map((candidate) => ({
    ...candidate,
    plannedOrphanSource: "fuzzy",
    plannedOrphanIsPrimary: false,
  }));

  return {
    ok: true,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    operation: {
      code: "plan-provider-dual-segments",
      description:
        "Plan explicit segments for only clean two-party adjacent TVDB/TMDB provider-season ownership. Both the existing owner and orphan side must independently form one contiguous constant-offset alignment using authoritative provider episode numbers and actual local AniCore episode numbers. This command never writes data.",
      resolvedCollisionGroups: resolvedGroups.length,
      adjacentOwnershipGroups,
      preliminarilyAlignedGroups: preliminary.length,
      safeDualSegmentGroups: safe.length,
      plannedNewAssociationCount: safe.length,
      plannedSegmentCount: safe.length * 2,
      byProvider,
      ownerOffsetDistribution: Object.fromEntries(
        [...ownerOffsetDistribution.entries()].sort(([a], [b]) => Number(a) - Number(b)),
      ),
      orphanOffsetDistribution: Object.fromEntries(
        [...orphanOffsetDistribution.entries()].sort(([a], [b]) => Number(a) - Number(b)),
      ),
      rejectedByReason: Object.fromEntries(
        [...rejectedByReason.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      candidateSamples,
      rejectedSamples: rejected
        .sort(
          (a, b) =>
            a.reason.localeCompare(b.reason) ||
            a.provider.localeCompare(b.provider) ||
            a.animeId - b.animeId,
        )
        .slice(0, 40),
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
