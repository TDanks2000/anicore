import { sql, type SQL } from "drizzle-orm";

import {
  closeDb,
  db,
  tryAcquireSyncLease,
  type SyncLease,
} from "@anicore/db";

import {
  buildOrphanParentRepairDiagnostics,
  type OrphanParentRepairDiagnostics,
} from "./orphan-episode-parent-diagnostics";
import {
  buildOrphanParentRepairPlan,
  type ExistingProviderIdentity,
  type OrphanEpisodeMappingRow,
  type OrphanParentRepairCandidate,
  type OrphanParentRepairPlan,
} from "./orphan-episode-parent-repair";
import { parseRepairMappingsArgs } from "./repair-mappings-cli";

type RepairMode = "dry-run" | "apply";

interface LegacyKitsuEpisodeSample {
  episodeMappingId: number;
  animeId: number;
  episodeProviderId: string;
  currentSource: string;
  currentConfidence: number;
  animeMappingId: number;
  animeProviderId: string;
  targetSource: string;
  targetConfidence: number;
}

interface KitsuProvenanceOperationReport {
  code: "kitsu-legacy-episode-provenance";
  description: string;
  plannedCount: number;
  appliedCount: number;
  remainingEligibleCount: number;
  skippedAmbiguousAnimeCount: number;
  samples: LegacyKitsuEpisodeSample[];
}

interface OrphanParentCandidateSample {
  animeId: number;
  provider: "thetvdb" | "tmdb";
  providerId: string;
  providerUrl: string | null;
  source: "fuzzy";
  confidence: number;
  episodeMappingCount: number;
  episodeMappingIds: number[];
}

interface OrphanParentOperationReport {
  code: "reconstruct-orphan-episode-parent-mappings";
  description: string;
  totalOrphanGroups: number;
  totalOrphanEpisodeMappings: number;
  plannedParentCount: number;
  plannedEpisodeMappingCount: number;
  appliedParentCount: number;
  resolvedEpisodeMappingCount: number;
  remainingOrphanEpisodeMappingCount: number;
  remainingEligibleParentCount: number;
  skipped: OrphanParentRepairPlan["skipped"];
  diagnostics: OrphanParentRepairDiagnostics;
  samples: OrphanParentCandidateSample[];
}

interface RepairReport {
  ok: true;
  mode: RepairMode;
  generatedAt: string;
  operations: {
    kitsuLegacyEpisodeProvenance: KitsuProvenanceOperationReport;
    orphanEpisodeParentMappings: OrphanParentOperationReport;
  };
}

async function queryRows<T extends Record<string, unknown>>(
  query: SQL,
): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as T[];
}

async function countLegacyKitsuEpisodeProvenance(): Promise<number> {
  const [row] = await queryRows<{ count: number }>(sql`
    select count(*)::int as count
    from episode_mappings em
    join episodes e on e.id = em.episode_id
    join anime_mappings am
      on am.anime_id = e.anime_id
      and am.provider = 'kitsu'
    where em.provider = 'kitsu'
      and em.source = 'api'
      and em.confidence = 100
      and am.source = 'fuzzy'
      and (
        select count(*)
        from anime_mappings all_am
        where all_am.anime_id = e.anime_id
          and all_am.provider = 'kitsu'
      ) = 1
  `);
  return Number(row?.count ?? 0);
}

async function countSkippedAmbiguousKitsuAnime(): Promise<number> {
  const [row] = await queryRows<{ count: number }>(sql`
    select count(distinct e.anime_id)::int as count
    from episode_mappings em
    join episodes e on e.id = em.episode_id
    where em.provider = 'kitsu'
      and em.source = 'api'
      and em.confidence = 100
      and exists (
        select 1
        from anime_mappings fuzzy_am
        where fuzzy_am.anime_id = e.anime_id
          and fuzzy_am.provider = 'kitsu'
          and fuzzy_am.source = 'fuzzy'
      )
      and (
        select count(*)
        from anime_mappings all_am
        where all_am.anime_id = e.anime_id
          and all_am.provider = 'kitsu'
      ) > 1
  `);
  return Number(row?.count ?? 0);
}

async function sampleLegacyKitsuEpisodeProvenance(): Promise<
  LegacyKitsuEpisodeSample[]
> {
  return queryRows<LegacyKitsuEpisodeSample>(sql`
    select
      em.id as "episodeMappingId",
      e.anime_id as "animeId",
      em.provider_id as "episodeProviderId",
      em.source as "currentSource",
      em.confidence as "currentConfidence",
      am.id as "animeMappingId",
      am.provider_id as "animeProviderId",
      am.source as "targetSource",
      am.confidence as "targetConfidence"
    from episode_mappings em
    join episodes e on e.id = em.episode_id
    join anime_mappings am
      on am.anime_id = e.anime_id
      and am.provider = 'kitsu'
    where em.provider = 'kitsu'
      and em.source = 'api'
      and em.confidence = 100
      and am.source = 'fuzzy'
      and (
        select count(*)
        from anime_mappings all_am
        where all_am.anime_id = e.anime_id
          and all_am.provider = 'kitsu'
      ) = 1
    order by em.id
    limit 20
  `);
}

async function applyLegacyKitsuEpisodeProvenanceRepair(): Promise<number> {
  const rows = await queryRows<{ episodeMappingId: number }>(sql`
    update episode_mappings em
    set
      source = am.source,
      confidence = am.confidence
    from episodes e, anime_mappings am
    where e.id = em.episode_id
      and am.anime_id = e.anime_id
      and am.provider = 'kitsu'
      and em.provider = 'kitsu'
      and em.source = 'api'
      and em.confidence = 100
      and am.source = 'fuzzy'
      and (
        select count(*)
        from anime_mappings all_am
        where all_am.anime_id = e.anime_id
          and all_am.provider = 'kitsu'
      ) = 1
    returning em.id as "episodeMappingId"
  `);
  return rows.length;
}

async function loadOrphanEpisodeMappingRows(): Promise<
  OrphanEpisodeMappingRow[]
> {
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
    where not exists (
      select 1
      from anime_mappings am
      where am.anime_id = e.anime_id
        and am.provider = em.provider
    )
    order by e.anime_id, em.provider, em.id
  `);
}

async function loadExistingProviderIdentities(): Promise<
  ExistingProviderIdentity[]
> {
  return queryRows<ExistingProviderIdentity>(sql`
    select anime_id as "animeId", provider, provider_id as "providerId"
    from anime_mappings
    where provider in ('thetvdb', 'tmdb')
    order by provider, provider_id, anime_id
  `);
}

async function buildCurrentOrphanParentPlan(): Promise<{
  rows: OrphanEpisodeMappingRow[];
  plan: OrphanParentRepairPlan;
  diagnostics: OrphanParentRepairDiagnostics;
}> {
  const [rows, existingIdentities] = await Promise.all([
    loadOrphanEpisodeMappingRows(),
    loadExistingProviderIdentities(),
  ]);
  return {
    rows,
    plan: buildOrphanParentRepairPlan(rows, existingIdentities),
    diagnostics: buildOrphanParentRepairDiagnostics(rows, existingIdentities),
  };
}

async function applyOrphanParentCandidates(
  candidates: OrphanParentRepairCandidate[],
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
          ${candidate.provider},
          ${candidate.providerId},
          null,
          ${candidate.providerUrl},
          ${candidate.confidence},
          'fuzzy',
          false
        where not exists (
          select 1
          from anime_mappings am
          where am.anime_id = ${candidate.animeId}
            and am.provider = ${candidate.provider}
        )
          and not exists (
            select 1
            from anime_mappings am
            where am.provider = ${candidate.provider}
              and am.provider_id = ${candidate.providerId}
          )
        returning id
      `);

      const inserted = [...result] as Array<{ id: number }>;
      if (inserted.length !== 1) {
        throw new Error(
          `Orphan parent repair candidate ${candidate.provider}:${candidate.providerId} for anime ${candidate.animeId} changed after planning; transaction rolled back`,
        );
      }
      insertedCount += 1;
    }

    return insertedCount;
  });
}

function sampleOrphanParentCandidates(
  candidates: OrphanParentRepairCandidate[],
): OrphanParentCandidateSample[] {
  return candidates.slice(0, 20).map((candidate) => ({
    animeId: candidate.animeId,
    provider: candidate.provider,
    providerId: candidate.providerId,
    providerUrl: candidate.providerUrl,
    source: candidate.source,
    confidence: candidate.confidence,
    episodeMappingCount: candidate.episodeMappingCount,
    episodeMappingIds: candidate.episodeMappingIds.slice(0, 10),
  }));
}

async function runRepair(mode: RepairMode): Promise<RepairReport> {
  const kitsuPlannedCount = await countLegacyKitsuEpisodeProvenance();
  const skippedAmbiguousAnimeCount = await countSkippedAmbiguousKitsuAnime();
  const kitsuSamples = await sampleLegacyKitsuEpisodeProvenance();

  const orphanBefore = await buildCurrentOrphanParentPlan();
  const plannedParentCount = orphanBefore.plan.candidates.length;
  const plannedEpisodeMappingCount = orphanBefore.plan.candidates.reduce(
    (total, candidate) => total + candidate.episodeMappingCount,
    0,
  );
  const orphanSamples = sampleOrphanParentCandidates(
    orphanBefore.plan.candidates,
  );

  let kitsuAppliedCount = 0;
  let appliedParentCount = 0;
  if (mode === "apply") {
    if (kitsuPlannedCount > 0) {
      kitsuAppliedCount = await applyLegacyKitsuEpisodeProvenanceRepair();
    }
    if (plannedParentCount > 0) {
      appliedParentCount = await applyOrphanParentCandidates(
        orphanBefore.plan.candidates,
      );
    }
  }

  const kitsuRemainingEligibleCount =
    mode === "apply"
      ? await countLegacyKitsuEpisodeProvenance()
      : kitsuPlannedCount;

  if (mode === "apply" && kitsuRemainingEligibleCount !== 0) {
    throw new Error(
      `Kitsu provenance repair left ${kitsuRemainingEligibleCount} eligible rows behind`,
    );
  }

  const orphanAfter =
    mode === "apply" ? await buildCurrentOrphanParentPlan() : orphanBefore;
  const resolvedEpisodeMappingCount =
    mode === "apply"
      ? orphanBefore.rows.length - orphanAfter.rows.length
      : 0;
  const remainingEligibleParentCount = orphanAfter.plan.candidates.length;

  if (mode === "apply") {
    if (appliedParentCount !== plannedParentCount) {
      throw new Error(
        `Orphan parent repair planned ${plannedParentCount} parents but inserted ${appliedParentCount}`,
      );
    }
    if (resolvedEpisodeMappingCount !== plannedEpisodeMappingCount) {
      throw new Error(
        `Orphan parent repair expected to resolve ${plannedEpisodeMappingCount} episode mappings but resolved ${resolvedEpisodeMappingCount}`,
      );
    }
    if (remainingEligibleParentCount !== 0) {
      throw new Error(
        `Orphan parent repair left ${remainingEligibleParentCount} reconstructable parent mappings behind`,
      );
    }
  }

  return {
    ok: true,
    mode,
    generatedAt: new Date().toISOString(),
    operations: {
      kitsuLegacyEpisodeProvenance: {
        code: "kitsu-legacy-episode-provenance",
        description:
          "Demote legacy Kitsu episode mappings from api/100 to the provenance and confidence of their single fuzzy Kitsu anime mapping. Manual/import/system episode mappings and anime with ambiguous Kitsu identities are never changed.",
        plannedCount: kitsuPlannedCount,
        appliedCount: kitsuAppliedCount,
        remainingEligibleCount: kitsuRemainingEligibleCount,
        skippedAmbiguousAnimeCount,
        samples: kitsuSamples,
      },
      orphanEpisodeParentMappings: {
        code: "reconstruct-orphan-episode-parent-mappings",
        description:
          "Reconstruct missing TVDB/TMDB anime-level parent mappings only when every orphan episode mapping in the anime/provider group is weak automatic evidence and its stored provider URL independently identifies the same provider season. Reconstructed parents are fuzzy, capped at 85 confidence, non-primary, and are skipped on incomplete, conflicting, strong/manual, unsupported, or colliding evidence.",
        totalOrphanGroups: orphanBefore.plan.totalOrphanGroups,
        totalOrphanEpisodeMappings:
          orphanBefore.plan.totalOrphanEpisodeMappings,
        plannedParentCount,
        plannedEpisodeMappingCount,
        appliedParentCount,
        resolvedEpisodeMappingCount,
        remainingOrphanEpisodeMappingCount:
          orphanAfter.plan.totalOrphanEpisodeMappings,
        remainingEligibleParentCount,
        skipped: orphanBefore.plan.skipped,
        diagnostics: orphanBefore.diagnostics,
        samples: orphanSamples,
      },
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
          "Another AniCore sync process already holds the database lease; repair was not started",
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
          `Failed to release mapping repair lease: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exitCode = 1;
      }
    }
    await closeDb().catch(() => undefined);
  }
}
