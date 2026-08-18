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
  type TvdbEpisodeBase,
  type TvdbSeriesBaseRecord,
} from "@anicore/providers/thetvdb/client";

import type {
  ExistingProviderIdentity,
  OrphanEpisodeMappingRow,
} from "./orphan-episode-parent-repair";
import {
  buildTvdbSlugResolutionGroups,
  filterTvdbSlugCandidateCollisions,
  verifyResolvedTvdbSlugGroup,
  type TvdbSlugRepairCandidate,
  type TvdbSlugResolutionGroup,
} from "./orphan-tvdb-slug-repair";
import { parseRepairMappingsArgs } from "./repair-mappings-cli";

type RepairMode = "dry-run" | "apply";

interface RejectedGroupSample {
  animeId: number;
  slug: string;
  seasonNumber: number;
  episodeMappingCount: number;
  reason: "slug-not-found" | "episode-verification-failed";
}

interface CandidateSample {
  animeId: number;
  providerId: string;
  providerSlug: string;
  confidence: number;
  episodeMappingCount: number;
  episodeMappingIds: number[];
}

interface RepairReport {
  ok: true;
  mode: RepairMode;
  generatedAt: string;
  operation: {
    code: "resolve-tvdb-slug-orphan-parents";
    description: string;
    totalTvdbOrphanGroups: number;
    totalTvdbOrphanEpisodeMappings: number;
    eligibleSlugGroups: number;
    eligibleSlugEpisodeMappings: number;
    skippedInvalidEvidenceGroups: number;
    skippedInvalidEvidenceEpisodeMappings: number;
    remoteVerifiedGroups: number;
    remoteRejectedGroups: number;
    skippedCollisionGroups: number;
    skippedCollisionEpisodeMappings: number;
    plannedParentCount: number;
    plannedEpisodeMappingCount: number;
    appliedParentCount: number;
    resolvedEpisodeMappingCount: number;
    remainingTvdbOrphanEpisodeMappings: number;
    rejectedSamples: RejectedGroupSample[];
    candidateSamples: CandidateSample[];
  };
}

async function queryRows<T extends Record<string, unknown>>(
  query: SQL,
): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as T[];
}

async function loadOrphanTvdbRows(): Promise<OrphanEpisodeMappingRow[]> {
  return queryRows<OrphanEpisodeMappingRow>(sql`
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
      em.confidence
    from episode_mappings em
    join episodes e on e.id = em.episode_id
    where em.provider = 'thetvdb'
      and not exists (
        select 1
        from anime_mappings am
        where am.anime_id = e.anime_id
          and am.provider = 'thetvdb'
      )
    order by e.anime_id, em.id
  `);
}

async function loadExistingTvdbIdentities(): Promise<ExistingProviderIdentity[]> {
  return queryRows<ExistingProviderIdentity>(sql`
    select anime_id as "animeId", provider, provider_id as "providerId"
    from anime_mappings
    where provider = 'thetvdb'
    order by provider_id, anime_id
  `);
}

async function countOrphanTvdbRows(): Promise<number> {
  const [row] = await queryRows<{ count: number }>(sql`
    select count(*)::int as count
    from episode_mappings em
    join episodes e on e.id = em.episode_id
    where em.provider = 'thetvdb'
      and not exists (
        select 1
        from anime_mappings am
        where am.anime_id = e.anime_id
          and am.provider = 'thetvdb'
      )
  `);
  return Number(row?.count ?? 0);
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

async function resolveGroupsAgainstTvdb(groups: TvdbSlugResolutionGroup[]): Promise<{
  candidates: TvdbSlugRepairCandidate[];
  rejected: RejectedGroupSample[];
}> {
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

  const getSeason = (
    seriesId: number,
    seasonNumber: number,
  ): Promise<TvdbEpisodeBase[]> => {
    const key = `${seriesId}:${seasonNumber}`;
    let promise = seasonCache.get(key);
    if (!promise) {
      promise = getTvdbSeasonEpisodes(seriesId, seasonNumber, "eng");
      seasonCache.set(key, promise);
    }
    return promise;
  };

  const outcomes = await mapWithConcurrency(groups, 4, async (group) => {
    let series: TvdbSeriesBaseRecord | null;
    try {
      series = await getSeries(group.slug);
    } catch (error) {
      if (isTvdbNotFoundError(error)) {
        return {
          candidate: null,
          rejected: {
            animeId: group.animeId,
            slug: group.slug,
            seasonNumber: group.seasonNumber,
            episodeMappingCount: group.episodeMappingIds.length,
            reason: "slug-not-found" as const,
          },
        };
      }
      throw error;
    }

    if (!series) {
      return {
        candidate: null,
        rejected: {
          animeId: group.animeId,
          slug: group.slug,
          seasonNumber: group.seasonNumber,
          episodeMappingCount: group.episodeMappingIds.length,
          reason: "slug-not-found" as const,
        },
      };
    }

    const seasonEpisodes = await getSeason(series.id, group.seasonNumber);
    const candidate = verifyResolvedTvdbSlugGroup(
      group,
      series,
      seasonEpisodes,
    );
    if (!candidate) {
      return {
        candidate: null,
        rejected: {
          animeId: group.animeId,
          slug: group.slug,
          seasonNumber: group.seasonNumber,
          episodeMappingCount: group.episodeMappingIds.length,
          reason: "episode-verification-failed" as const,
        },
      };
    }

    return { candidate, rejected: null };
  });

  return {
    candidates: outcomes
      .map((outcome) => outcome.candidate)
      .filter((candidate): candidate is TvdbSlugRepairCandidate => Boolean(candidate)),
    rejected: outcomes
      .map((outcome) => outcome.rejected)
      .filter((sample): sample is RejectedGroupSample => Boolean(sample)),
  };
}

async function applyCandidates(
  candidates: TvdbSlugRepairCandidate[],
): Promise<number> {
  if (candidates.length === 0) return 0;

  return db.transaction(async (tx) => {
    let insertedCount = 0;
    for (const candidate of candidates) {
      const result = await tx.execute(sql`
        insert into anime_mappings (
          anime_id,
          provider,
          provider_id,
          provider_slug,
          provider_url,
          confidence,
          source,
          is_primary
        )
        select
          ${candidate.animeId},
          'thetvdb',
          ${candidate.providerId},
          ${candidate.providerSlug},
          ${candidate.providerUrl},
          ${candidate.confidence},
          'fuzzy',
          false
        where not exists (
          select 1
          from anime_mappings am
          where am.anime_id = ${candidate.animeId}
            and am.provider = 'thetvdb'
        )
          and not exists (
            select 1
            from anime_mappings am
            where am.provider = 'thetvdb'
              and am.provider_id = ${candidate.providerId}
          )
        returning id
      `);

      const inserted = [...result] as Array<{ id: number }>;
      if (inserted.length !== 1) {
        throw new Error(
          `TVDB orphan repair candidate ${candidate.providerId} for anime ${candidate.animeId} changed after planning; transaction rolled back`,
        );
      }
      insertedCount += 1;
    }
    return insertedCount;
  });
}

function sampleCandidates(
  candidates: TvdbSlugRepairCandidate[],
): CandidateSample[] {
  return candidates.slice(0, 20).map((candidate) => ({
    animeId: candidate.animeId,
    providerId: candidate.providerId,
    providerSlug: candidate.providerSlug,
    confidence: candidate.confidence,
    episodeMappingCount: candidate.episodeMappingCount,
    episodeMappingIds: candidate.episodeMappingIds.slice(0, 10),
  }));
}

async function runRepair(mode: RepairMode): Promise<RepairReport> {
  if (!process.env.TVDB_API_KEY?.trim()) {
    throw new Error(
      "TVDB_API_KEY is required to resolve legacy TVDB slug orphan mappings",
    );
  }

  const [orphanRows, existingIdentities] = await Promise.all([
    loadOrphanTvdbRows(),
    loadExistingTvdbIdentities(),
  ]);
  const groupPlan = buildTvdbSlugResolutionGroups(orphanRows);
  const eligibleSlugEpisodeMappings = groupPlan.groups.reduce(
    (total, group) => total + group.episodeMappingIds.length,
    0,
  );

  const resolved = await resolveGroupsAgainstTvdb(groupPlan.groups);
  const collisionFiltered = filterTvdbSlugCandidateCollisions(
    resolved.candidates,
    existingIdentities,
  );
  const candidates = collisionFiltered.candidates;
  const plannedEpisodeMappingCount = candidates.reduce(
    (total, candidate) => total + candidate.episodeMappingCount,
    0,
  );

  let appliedParentCount = 0;
  if (mode === "apply" && candidates.length > 0) {
    appliedParentCount = await applyCandidates(candidates);
  }

  const remainingTvdbOrphanEpisodeMappings =
    mode === "apply" ? await countOrphanTvdbRows() : orphanRows.length;
  const resolvedEpisodeMappingCount =
    mode === "apply"
      ? orphanRows.length - remainingTvdbOrphanEpisodeMappings
      : 0;

  if (mode === "apply") {
    if (appliedParentCount !== candidates.length) {
      throw new Error(
        `TVDB orphan repair planned ${candidates.length} parents but inserted ${appliedParentCount}`,
      );
    }
    if (resolvedEpisodeMappingCount !== plannedEpisodeMappingCount) {
      throw new Error(
        `TVDB orphan repair expected to resolve ${plannedEpisodeMappingCount} episode mappings but resolved ${resolvedEpisodeMappingCount}`,
      );
    }
  }

  return {
    ok: true,
    mode,
    generatedAt: new Date().toISOString(),
    operation: {
      code: "resolve-tvdb-slug-orphan-parents",
      description:
        "Resolve legacy TVDB episode URLs containing textual series slugs through TVDB's authoritative slug endpoint, then require every stored episode ID and episode number to match the resolved TVDB season before reconstructing a fuzzy/non-primary anime-level mapping. TMDB collision groups are intentionally out of scope.",
      totalTvdbOrphanGroups: groupPlan.totalTvdbOrphanGroups,
      totalTvdbOrphanEpisodeMappings: groupPlan.totalTvdbOrphanEpisodeMappings,
      eligibleSlugGroups: groupPlan.groups.length,
      eligibleSlugEpisodeMappings,
      skippedInvalidEvidenceGroups: groupPlan.skippedInvalidEvidenceGroups,
      skippedInvalidEvidenceEpisodeMappings:
        groupPlan.skippedInvalidEvidenceEpisodeMappings,
      remoteVerifiedGroups: resolved.candidates.length,
      remoteRejectedGroups: resolved.rejected.length,
      skippedCollisionGroups: collisionFiltered.skippedCollisionGroups,
      skippedCollisionEpisodeMappings:
        collisionFiltered.skippedCollisionEpisodeMappings,
      plannedParentCount: candidates.length,
      plannedEpisodeMappingCount,
      appliedParentCount,
      resolvedEpisodeMappingCount,
      remainingTvdbOrphanEpisodeMappings,
      rejectedSamples: resolved.rejected.slice(0, 20),
      candidateSamples: sampleCandidates(candidates),
    },
  };
}

if (import.meta.main) {
  const { mode } = parseRepairMappingsArgs(Bun.argv.slice(2));
  let syncLease: SyncLease | null = null;
  let succeeded = false;

  try {
    if (mode === "apply") {
      syncLease = await tryAcquireSyncLease();
      if (!syncLease) {
        throw new Error(
          "Another AniCore sync process already holds the database lease; TVDB repair was not started",
        );
      }
    }

    const report = await runRepair(mode);
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
    if (syncLease) {
      try {
        await syncLease.release(succeeded);
      } catch (error) {
        console.error(
          `Failed to release TVDB orphan repair lease: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exitCode = 1;
      }
    }
    await closeDb().catch(() => undefined);
  }
}
