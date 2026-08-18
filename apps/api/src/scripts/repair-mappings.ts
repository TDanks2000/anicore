import { sql, type SQL } from "drizzle-orm";

import {
  closeDb,
  db,
  tryAcquireSyncLease,
  type SyncLease,
} from "@anicore/db";

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

interface RepairReport {
  ok: true;
  mode: RepairMode;
  generatedAt: string;
  operation: {
    code: "kitsu-legacy-episode-provenance";
    description: string;
    plannedCount: number;
    appliedCount: number;
    remainingEligibleCount: number;
    skippedAmbiguousAnimeCount: number;
    samples: LegacyKitsuEpisodeSample[];
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

async function runRepair(mode: RepairMode): Promise<RepairReport> {
  const plannedCount = await countLegacyKitsuEpisodeProvenance();
  const skippedAmbiguousAnimeCount = await countSkippedAmbiguousKitsuAnime();
  const samples = await sampleLegacyKitsuEpisodeProvenance();

  let appliedCount = 0;
  if (mode === "apply" && plannedCount > 0) {
    appliedCount = await applyLegacyKitsuEpisodeProvenanceRepair();
  }

  const remainingEligibleCount =
    mode === "apply" ? await countLegacyKitsuEpisodeProvenance() : plannedCount;

  if (mode === "apply" && remainingEligibleCount !== 0) {
    throw new Error(
      `Kitsu provenance repair left ${remainingEligibleCount} eligible rows behind`,
    );
  }

  return {
    ok: true,
    mode,
    generatedAt: new Date().toISOString(),
    operation: {
      code: "kitsu-legacy-episode-provenance",
      description:
        "Demote legacy Kitsu episode mappings from api/100 to the provenance and confidence of their single fuzzy Kitsu anime mapping. Manual/import/system episode mappings and anime with ambiguous Kitsu identities are never changed.",
      plannedCount,
      appliedCount,
      remainingEligibleCount,
      skippedAmbiguousAnimeCount,
      samples,
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
