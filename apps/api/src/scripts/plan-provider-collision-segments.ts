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
  buildLinearCollisionSegment,
  buildTmdbResolvedCollisionGroups,
  filterOverlappingCollisionSegments,
  type CollisionEpisodeMappingRow,
  type CollisionSegmentCandidate,
  type ResolvedCollisionGroup,
  type SegmentRejectReason,
} from "./provider-collision-segment-plan";

type Provider = "thetvdb" | "tmdb";

type RejectReason =
  | SegmentRejectReason
  | "tvdb-slug-not-found"
  | "tvdb-episode-verification-failed"
  | "missing-provider-entity"
  | "provider-entity-has-no-other-owner"
  | "overlapping-candidate-segment";

interface ProviderEntityOwnerRow {
  providerEntityId: number;
  provider: Provider;
  providerId: string;
  ownerAnimeId: number;
}

interface RejectedSample {
  animeId: number;
  provider: Provider;
  providerId: string | null;
  episodeMappingCount: number;
  reason: RejectReason;
}

interface CandidateSample {
  animeId: number;
  provider: Provider;
  providerId: string;
  providerEntityId: number;
  existingOwnerAnimeIds: number[];
  providerRange: string;
  localRange: string;
  offset: number;
  episodeMappingCount: number;
}

interface ProviderStats {
  orphanGroups: number;
  orphanEpisodeMappings: number;
  resolvedIdentityGroups: number;
  linearSegmentGroups: number;
  structuralCollisionGroups: number;
  structuralCollisionEpisodeMappings: number;
}

interface PlanReport {
  ok: true;
  mode: "dry-run";
  generatedAt: string;
  operation: {
    code: "plan-provider-collision-segments";
    description: string;
    totalOrphanGroups: number;
    totalOrphanEpisodeMappings: number;
    normalOrphanEpisodeMappings: number;
    nonNormalOrphanEpisodeMappings: number;
    resolvedIdentityGroups: number;
    linearSegmentGroups: number;
    structuralCollisionGroups: number;
    structuralCollisionEpisodeMappings: number;
    overlappingCandidateGroups: number;
    rejectedGroups: number;
    byProvider: Record<Provider, ProviderStats>;
    rejectedByReason: Record<string, { groups: number; episodeMappings: number }>;
    candidateSamples: CandidateSample[];
    rejectedSamples: RejectedSample[];
    ownerSegmentValidationRequired: true;
  };
}

async function queryRows<T extends Record<string, unknown>>(
  query: SQL,
): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as T[];
}

function key(provider: string, providerId: string): string {
  return `${provider}\u0000${providerId}`;
}

function groupKey(animeId: number, provider: string): string {
  return `${animeId}\u0000${provider}`;
}

async function countAllOrphanRows(): Promise<number> {
  const [row] = await queryRows<{ count: number }>(sql`
    select count(*)::int as count
    from public.episode_mappings em
    join public.episodes e on e.id = em.episode_id
    where em.provider in ('thetvdb', 'tmdb')
      and not exists (
        select 1
        from public.anime_mappings am
        where am.anime_id = e.anime_id
          and am.provider = em.provider
      )
  `);
  return Number(row?.count ?? 0);
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

async function loadProviderEntityOwners(): Promise<ProviderEntityOwnerRow[]> {
  return queryRows<ProviderEntityOwnerRow>(sql`
    select
      pe.id as "providerEntityId",
      pe.provider,
      pe.provider_id as "providerId",
      apm.anime_id as "ownerAnimeId"
    from public.provider_entities pe
    join public.anime_provider_mappings apm
      on apm.provider_entity_id = pe.id
    where pe.provider in ('thetvdb', 'tmdb')
    order by pe.provider, pe.provider_id, apm.anime_id
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

async function resolveTvdbGroups(
  rows: CollisionEpisodeMappingRow[],
): Promise<{
  groups: ResolvedCollisionGroup[];
  rejected: RejectedSample[];
}> {
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

  const getSeason = (
    seriesId: number,
    seasonNumber: number,
  ): Promise<TvdbEpisodeBase[]> => {
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
    async (group: TvdbSlugResolutionGroup) => {
      let series: TvdbSeriesBaseRecord | null;
      try {
        series = await getSeries(group.slug);
      } catch (error) {
        if (isTvdbNotFoundError(error)) series = null;
        else throw error;
      }

      if (!series) {
        return {
          group: null,
          rejected: {
            animeId: group.animeId,
            provider: "thetvdb" as const,
            providerId: null,
            episodeMappingCount: group.episodeMappingIds.length,
            reason: "tvdb-slug-not-found" as const,
          },
        };
      }

      const season = await getSeason(series.id, group.seasonNumber);
      const verified = verifyResolvedTvdbSlugGroup(group, series, season);
      if (!verified) {
        return {
          group: null,
          rejected: {
            animeId: group.animeId,
            provider: "thetvdb" as const,
            providerId: `${series.id}:${group.seasonNumber}`,
            episodeMappingCount: group.episodeMappingIds.length,
            reason: "tvdb-episode-verification-failed" as const,
          },
        };
      }

      return {
        group: {
          animeId: verified.animeId,
          provider: "thetvdb" as const,
          providerId: verified.providerId,
          providerSlug: verified.providerSlug,
          providerUrl: verified.providerUrl,
          confidence: verified.confidence,
          rows: rowsByAnime.get(verified.animeId) ?? [],
        } satisfies ResolvedCollisionGroup,
        rejected: null,
      };
    },
  );

  const representedAnime = new Set(groupPlan.groups.map((group) => group.animeId));
  const rejected: RejectedSample[] = outcomes
    .map((outcome) => outcome.rejected)
    .filter((sample): sample is RejectedSample => Boolean(sample));

  for (const [animeId, groupRows] of rowsByAnime) {
    if (!representedAnime.has(animeId)) {
      rejected.push({
        animeId,
        provider: "thetvdb",
        providerId: null,
        episodeMappingCount: groupRows.length,
        reason: "conflicting-provider-identity",
      });
    }
  }

  return {
    groups: outcomes
      .map((outcome) => outcome.group)
      .filter((group): group is ResolvedCollisionGroup => Boolean(group)),
    rejected,
  };
}

function incrementReject(
  summary: Map<string, { groups: number; episodeMappings: number }>,
  reason: string,
  episodeMappingCount: number,
): void {
  const current = summary.get(reason) ?? { groups: 0, episodeMappings: 0 };
  current.groups += 1;
  current.episodeMappings += episodeMappingCount;
  summary.set(reason, current);
}

function emptyProviderStats(): ProviderStats {
  return {
    orphanGroups: 0,
    orphanEpisodeMappings: 0,
    resolvedIdentityGroups: 0,
    linearSegmentGroups: 0,
    structuralCollisionGroups: 0,
    structuralCollisionEpisodeMappings: 0,
  };
}

async function run(): Promise<PlanReport> {
  const [totalOrphanEpisodeMappings, rows, ownerRows] = await Promise.all([
    countAllOrphanRows(),
    loadNormalOrphanRows(),
    loadProviderEntityOwners(),
  ]);

  if (rows.some((row) => row.provider === "thetvdb") && !process.env.TVDB_API_KEY?.trim()) {
    throw new Error(
      "TVDB_API_KEY is required to verify TVDB collision identities before planning segments",
    );
  }

  const groupIds = new Set(rows.map((row) => groupKey(row.animeId, row.provider)));
  const byProvider: Record<Provider, ProviderStats> = {
    thetvdb: emptyProviderStats(),
    tmdb: emptyProviderStats(),
  };
  for (const row of rows) byProvider[row.provider as Provider].orphanEpisodeMappings += 1;
  for (const groupId of groupIds) {
    const provider = groupId.split("\u0000")[1] as Provider;
    byProvider[provider].orphanGroups += 1;
  }

  const tmdbPlan = buildTmdbResolvedCollisionGroups(rows);
  const tvdbPlan = await resolveTvdbGroups(rows);
  const resolvedGroups = [...tmdbPlan.groups, ...tvdbPlan.groups];
  for (const group of resolvedGroups) byProvider[group.provider].resolvedIdentityGroups += 1;

  const rejected: RejectedSample[] = [
    ...tmdbPlan.rejected.map((item) => ({
      animeId: item.animeId,
      provider: "tmdb" as const,
      providerId: null,
      episodeMappingCount: item.episodeMappingCount,
      reason: item.reason,
    })),
    ...tvdbPlan.rejected,
  ];

  const linearCandidates: CollisionSegmentCandidate[] = [];
  for (const group of resolvedGroups) {
    const outcome = buildLinearCollisionSegment(group);
    if (!outcome.candidate) {
      rejected.push({
        animeId: group.animeId,
        provider: group.provider,
        providerId: group.providerId,
        episodeMappingCount: group.rows.length,
        reason: outcome.reason!,
      });
      continue;
    }
    linearCandidates.push(outcome.candidate);
    byProvider[group.provider].linearSegmentGroups += 1;
  }

  const ownerMap = new Map<
    string,
    { providerEntityId: number; ownerAnimeIds: Set<number> }
  >();
  for (const owner of ownerRows) {
    const identity = key(owner.provider, owner.providerId);
    const current = ownerMap.get(identity) ?? {
      providerEntityId: owner.providerEntityId,
      ownerAnimeIds: new Set<number>(),
    };
    current.ownerAnimeIds.add(owner.ownerAnimeId);
    ownerMap.set(identity, current);
  }

  const structuralCandidates: CollisionSegmentCandidate[] = [];
  const candidateOwnerInfo = new Map<
    string,
    { providerEntityId: number; ownerAnimeIds: number[] }
  >();
  for (const candidate of linearCandidates) {
    const identity = key(candidate.provider, candidate.providerId);
    const owner = ownerMap.get(identity);
    if (!owner) {
      rejected.push({
        animeId: candidate.animeId,
        provider: candidate.provider,
        providerId: candidate.providerId,
        episodeMappingCount: candidate.episodeMappingCount,
        reason: "missing-provider-entity",
      });
      continue;
    }
    const otherOwners = [...owner.ownerAnimeIds]
      .filter((animeId) => animeId !== candidate.animeId)
      .sort((a, b) => a - b);
    if (otherOwners.length === 0) {
      rejected.push({
        animeId: candidate.animeId,
        provider: candidate.provider,
        providerId: candidate.providerId,
        episodeMappingCount: candidate.episodeMappingCount,
        reason: "provider-entity-has-no-other-owner",
      });
      continue;
    }
    structuralCandidates.push(candidate);
    candidateOwnerInfo.set(`${candidate.animeId}\u0000${identity}`, {
      providerEntityId: owner.providerEntityId,
      ownerAnimeIds: otherOwners,
    });
  }

  const overlapFiltered = filterOverlappingCollisionSegments(structuralCandidates);
  for (const candidate of overlapFiltered.rejected) {
    rejected.push({
      animeId: candidate.animeId,
      provider: candidate.provider,
      providerId: candidate.providerId,
      episodeMappingCount: candidate.episodeMappingCount,
      reason: "overlapping-candidate-segment",
    });
  }

  for (const candidate of overlapFiltered.candidates) {
    byProvider[candidate.provider].structuralCollisionGroups += 1;
    byProvider[candidate.provider].structuralCollisionEpisodeMappings +=
      candidate.episodeMappingCount;
  }

  const rejectedByReason = new Map<
    string,
    { groups: number; episodeMappings: number }
  >();
  for (const item of rejected) {
    incrementReject(rejectedByReason, item.reason, item.episodeMappingCount);
  }

  const candidateSamples: CandidateSample[] = overlapFiltered.candidates
    .slice(0, 30)
    .map((candidate) => {
      const owner = candidateOwnerInfo.get(
        `${candidate.animeId}\u0000${key(candidate.provider, candidate.providerId)}`,
      )!;
      return {
        animeId: candidate.animeId,
        provider: candidate.provider,
        providerId: candidate.providerId,
        providerEntityId: owner.providerEntityId,
        existingOwnerAnimeIds: owner.ownerAnimeIds,
        providerRange: `${candidate.providerEpisodeStart}-${candidate.providerEpisodeEnd}`,
        localRange: `${candidate.localEpisodeStart}-${candidate.localEpisodeEnd}`,
        offset: candidate.offset,
        episodeMappingCount: candidate.episodeMappingCount,
      };
    });

  return {
    ok: true,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    operation: {
      code: "plan-provider-collision-segments",
      description:
        "Classify orphan TVDB/TMDB episode mappings into explicit split-cour/merged-season segment candidates. A candidate must resolve to one real provider season, cover every stored normal local episode, form one contiguous constant-offset provider/local sequence, point at an existing canonical provider entity owned by another anime, and not overlap another candidate segment. This command never writes data.",
      totalOrphanGroups: groupIds.size,
      totalOrphanEpisodeMappings,
      normalOrphanEpisodeMappings: rows.length,
      nonNormalOrphanEpisodeMappings: totalOrphanEpisodeMappings - rows.length,
      resolvedIdentityGroups: resolvedGroups.length,
      linearSegmentGroups: linearCandidates.length,
      structuralCollisionGroups: overlapFiltered.candidates.length,
      structuralCollisionEpisodeMappings: overlapFiltered.candidates.reduce(
        (total, candidate) => total + candidate.episodeMappingCount,
        0,
      ),
      overlappingCandidateGroups: overlapFiltered.rejected.length,
      rejectedGroups: rejected.length,
      byProvider,
      rejectedByReason: Object.fromEntries(
        [...rejectedByReason.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      candidateSamples,
      rejectedSamples: rejected
        .sort(
          (a, b) =>
            a.provider.localeCompare(b.provider) ||
            a.animeId - b.animeId ||
            a.reason.localeCompare(b.reason),
        )
        .slice(0, 30),
      ownerSegmentValidationRequired: true,
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
    const report = await run();
    console.log(JSON.stringify(report, null, 2));
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
