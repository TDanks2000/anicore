import { sql, type SQL } from "drizzle-orm";

import {
  closeDb,
  db,
  tryAcquireSyncLease,
  type SyncLease,
} from "@anicore/db";

import { parseRepairMappingsArgs } from "./repair-mappings-cli";

const PROVIDER = "thetvdb" as const;
const PROVIDER_ID = "79101:1";
const TARGET_ANIME_ID = 223;
const CURRENT_OWNER_ANIME_ID = 13285;
const RECAP_NUMBER = 13;
const EXPECTED_PROVIDER_EPISODE_IDS = [
  "302756",
  "302757",
  "302758",
  "302759",
  "302760",
  "302761",
  "305154",
  "305155",
  "305156",
  "305157",
  "305158",
  "305159",
  "365054",
] as const;

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ExecuteSql = (query: SQL) => Promise<unknown>;

interface LegacyMappingPlanRow {
  id: number;
  animeId: number;
  source: string;
  confidence: number;
  isPrimary: boolean;
}

interface V2AssociationPlanRow extends LegacyMappingPlanRow {
  segmentCount: number;
}

interface NewLegacyMappingPlanRow {
  animeId: number;
  provider: "thetvdb";
  providerId: string;
  source: "system";
  confidence: number;
  isPrimary: boolean;
}

interface NewAssociationPlanRow {
  animeId: number;
  providerEntityId: number;
  source: "system";
  confidence: number;
  isPrimary: boolean;
}

interface EpisodeReassignmentPlanRow {
  episodeMappingId: number;
  providerEpisodeId: string;
  providerEpisodeNumber: number;
  fromAnimeId: number;
  fromEpisodeId: number;
  toAnimeId: number;
  toEpisodeId: number;
  toLocalEpisodeNumber: number;
  preserveSource: string;
  preserveConfidence: number;
}

interface EpisodeCreatePlanRow {
  animeId: number;
  number: number;
  sortNumber: number;
  kind: "recap";
  title: string;
  titleEnglish: string;
  synopsis: string;
  airDate: string;
  seasonNumber: number;
}

interface EpisodeMappingCreatePlanRow {
  provider: "thetvdb";
  providerEpisodeId: string;
  providerEpisodeNumber: string;
  source: "system";
  confidence: number;
}

interface AirPlannerOperation {
  code: "plan-air-recap-repair";
  provider: "thetvdb";
  providerId: string;
  providerEntityId: number;
  evidence: {
    targetAnimeId: number;
    currentOwnerAnimeId: number;
    normalEpisodeRange: number[];
    recap: {
      providerEpisodeId: string;
      providerEpisodeNumber: number;
      title: string;
      overview: string;
      airDate: string;
      seasonNumber: number;
      localKind: "recap";
      localEpisodeNumber: number;
    };
  };
  plan: {
    retireLegacyMappings: LegacyMappingPlanRow[];
    retireV2Associations: V2AssociationPlanRow[];
    createLegacyMappings: NewLegacyMappingPlanRow[];
    createV2Associations: NewAssociationPlanRow[];
    episodeMappingReassignments: EpisodeReassignmentPlanRow[];
    createEpisodes: EpisodeCreatePlanRow[];
    createEpisodeMappings: EpisodeMappingCreatePlanRow[];
  };
  totals: {
    legacyMappingsToRetire: number;
    v2AssociationsToRetire: number;
    legacyMappingsToCreate: number;
    v2AssociationsToCreate: number;
    episodeMappingsToReassign: number;
    recapEpisodesToCreate: number;
    recapEpisodeMappingsToCreate: number;
  };
}

interface AirPlannerOutput {
  ok: boolean;
  mode: "dry-run";
  operation?: AirPlannerOperation;
  error?: string;
}

interface ParentVerificationRow {
  animeId: number;
  providerEntityId: number | null;
  source: string;
  confidence: number;
  isPrimary: boolean;
  segmentCount: number;
}

interface EpisodeVerificationRow {
  mappingId: number;
  animeId: number;
  episodeId: number;
  localEpisodeNumber: number;
  localKind: string;
  title: string | null;
  titleEnglish: string | null;
  synopsis: string | null;
  airDate: string | null;
  seasonNumber: number | null;
  providerId: string;
  providerEpisodeNumber: string | null;
  source: string;
  confidence: number;
}

function fail(message: string): never {
  throw new Error(message);
}

async function rowsWith<T>(execute: ExecuteSql, query: SQL): Promise<T[]> {
  const result = await execute(query);
  return [...(result as Iterable<unknown>)] as unknown as T[];
}

async function runPlanner(): Promise<AirPlannerOperation> {
  const script = `${import.meta.dir}/plan-air-recap-repair.ts`;
  const processHandle = Bun.spawn([process.execPath, script], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  if (exitCode !== 0) {
    fail(
      `AIR recap repair planner failed with exit code ${exitCode}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  const parsed = JSON.parse(stdout) as AirPlannerOutput;
  if (!parsed.ok || parsed.mode !== "dry-run" || !parsed.operation) {
    fail(parsed.error ?? "AIR recap repair planner did not return a successful dry-run result");
  }
  validatePlan(parsed.operation);
  return parsed.operation;
}

function validatePlan(plan: AirPlannerOperation): void {
  if (
    plan.code !== "plan-air-recap-repair" ||
    plan.provider !== PROVIDER ||
    plan.providerId !== PROVIDER_ID ||
    plan.evidence.targetAnimeId !== TARGET_ANIME_ID ||
    plan.evidence.currentOwnerAnimeId !== CURRENT_OWNER_ANIME_ID
  ) {
    fail("AIR planner returned an unexpected identity");
  }

  const totals = plan.totals;
  if (
    totals.legacyMappingsToRetire !== 1 ||
    totals.v2AssociationsToRetire !== 1 ||
    totals.legacyMappingsToCreate !== 1 ||
    totals.v2AssociationsToCreate !== 1 ||
    totals.episodeMappingsToReassign !== 1 ||
    totals.recapEpisodesToCreate !== 1 ||
    totals.recapEpisodeMappingsToCreate !== 1
  ) {
    fail(`AIR planner totals no longer match the proven repair: ${JSON.stringify(totals)}`);
  }

  const [legacy] = plan.plan.retireLegacyMappings;
  const [oldV2] = plan.plan.retireV2Associations;
  const [newLegacy] = plan.plan.createLegacyMappings;
  const [newV2] = plan.plan.createV2Associations;
  const [move] = plan.plan.episodeMappingReassignments;
  const [recapEpisode] = plan.plan.createEpisodes;
  const [recapMapping] = plan.plan.createEpisodeMappings;
  const recap = plan.evidence.recap;

  if (
    !legacy ||
    plan.plan.retireLegacyMappings.length !== 1 ||
    legacy.animeId !== CURRENT_OWNER_ANIME_ID ||
    !oldV2 ||
    plan.plan.retireV2Associations.length !== 1 ||
    oldV2.animeId !== CURRENT_OWNER_ANIME_ID ||
    oldV2.segmentCount !== 0 ||
    !newLegacy ||
    plan.plan.createLegacyMappings.length !== 1 ||
    newLegacy.animeId !== TARGET_ANIME_ID ||
    newLegacy.provider !== PROVIDER ||
    newLegacy.providerId !== PROVIDER_ID ||
    newLegacy.source !== "system" ||
    newLegacy.confidence < 95 ||
    !newLegacy.isPrimary ||
    !newV2 ||
    plan.plan.createV2Associations.length !== 1 ||
    newV2.animeId !== TARGET_ANIME_ID ||
    newV2.providerEntityId !== plan.providerEntityId ||
    newV2.source !== "system" ||
    newV2.confidence < 95 ||
    !newV2.isPrimary
  ) {
    fail("AIR planner parent mapping rows no longer match the proven repair");
  }

  if (
    !move ||
    plan.plan.episodeMappingReassignments.length !== 1 ||
    move.providerEpisodeId !== EXPECTED_PROVIDER_EPISODE_IDS[0] ||
    move.providerEpisodeNumber !== 1 ||
    move.fromAnimeId !== CURRENT_OWNER_ANIME_ID ||
    move.toAnimeId !== TARGET_ANIME_ID ||
    move.toLocalEpisodeNumber !== 1
  ) {
    fail("AIR planner episode 1 reassignment no longer matches the proven repair");
  }

  if (
    recap.providerEpisodeId !== EXPECTED_PROVIDER_EPISODE_IDS[12] ||
    recap.providerEpisodeNumber !== RECAP_NUMBER ||
    recap.title !== "Memories" ||
    recap.overview !== "Summary of Misuzu Kamio's story arc." ||
    recap.airDate !== "2005-04-01" ||
    recap.seasonNumber !== 1 ||
    recap.localKind !== "recap" ||
    recap.localEpisodeNumber !== RECAP_NUMBER ||
    !recapEpisode ||
    plan.plan.createEpisodes.length !== 1 ||
    recapEpisode.animeId !== TARGET_ANIME_ID ||
    recapEpisode.number !== RECAP_NUMBER ||
    recapEpisode.sortNumber !== RECAP_NUMBER ||
    recapEpisode.kind !== "recap" ||
    recapEpisode.title !== recap.title ||
    recapEpisode.titleEnglish !== recap.title ||
    recapEpisode.synopsis !== recap.overview ||
    recapEpisode.airDate !== recap.airDate ||
    recapEpisode.seasonNumber !== recap.seasonNumber ||
    !recapMapping ||
    plan.plan.createEpisodeMappings.length !== 1 ||
    recapMapping.provider !== PROVIDER ||
    recapMapping.providerEpisodeId !== recap.providerEpisodeId ||
    Number(recapMapping.providerEpisodeNumber) !== RECAP_NUMBER ||
    recapMapping.source !== "system" ||
    recapMapping.confidence < 95
  ) {
    fail("AIR planner recap rows no longer match the proven Memories recap evidence");
  }
}

async function detectAlreadyApplied(execute: ExecuteSql): Promise<boolean> {
  const providerEntities = await rowsWith<{ id: number }>(execute, sql`
    select id
    from public.provider_entities
    where provider = ${PROVIDER} and provider_id = ${PROVIDER_ID}
  `);
  if (providerEntities.length !== 1) return false;
  const providerEntityId = providerEntities[0]!.id;

  const legacy = await rowsWith<{
    animeId: number;
    source: string;
    confidence: number;
    isPrimary: boolean;
  }>(execute, sql`
    select
      anime_id as "animeId",
      source,
      confidence,
      is_primary as "isPrimary"
    from public.anime_mappings
    where provider = ${PROVIDER} and provider_id = ${PROVIDER_ID}
  `);
  if (
    legacy.length !== 1 ||
    legacy[0]?.animeId !== TARGET_ANIME_ID ||
    legacy[0]?.source !== "system" ||
    (legacy[0]?.confidence ?? 0) < 95 ||
    !legacy[0]?.isPrimary
  ) {
    return false;
  }

  const associations = await rowsWith<ParentVerificationRow>(execute, sql`
    select
      apm.anime_id as "animeId",
      apm.provider_entity_id as "providerEntityId",
      apm.source,
      apm.confidence,
      apm.is_primary as "isPrimary",
      count(aps.id)::int as "segmentCount"
    from public.anime_provider_mappings apm
    left join public.anime_provider_segments aps
      on aps.anime_provider_mapping_id = apm.id
    where apm.provider_entity_id = ${providerEntityId}
    group by apm.id
    order by apm.id
  `);
  if (
    associations.length !== 1 ||
    associations[0]?.animeId !== TARGET_ANIME_ID ||
    associations[0]?.providerEntityId !== providerEntityId ||
    associations[0]?.source !== "system" ||
    (associations[0]?.confidence ?? 0) < 95 ||
    !associations[0]?.isPrimary ||
    associations[0]?.segmentCount !== 0
  ) {
    return false;
  }

  const providerIds = EXPECTED_PROVIDER_EPISODE_IDS.map((id) => sql`${id}`);
  const episodeRows = await rowsWith<EpisodeVerificationRow>(execute, sql`
    select
      em.id as "mappingId",
      e.anime_id as "animeId",
      e.id as "episodeId",
      e.number as "localEpisodeNumber",
      e.kind as "localKind",
      e.title,
      e.title_english as "titleEnglish",
      e.synopsis,
      e.air_date as "airDate",
      e.season_number as "seasonNumber",
      em.provider_id as "providerId",
      em.provider_episode_number as "providerEpisodeNumber",
      em.source,
      em.confidence
    from public.episode_mappings em
    join public.episodes e on e.id = em.episode_id
    where em.provider = ${PROVIDER}
      and em.provider_id in (${sql.join(providerIds, sql`, `)})
    order by em.provider_episode_number::int, em.id
  `);
  if (episodeRows.length !== RECAP_NUMBER) return false;
  if (new Set(episodeRows.map((row) => row.providerId)).size !== RECAP_NUMBER) return false;

  for (let number = 1; number <= 12; number += 1) {
    const expectedProviderId = EXPECTED_PROVIDER_EPISODE_IDS[number - 1]!;
    const row = episodeRows.find((candidate) => candidate.providerId === expectedProviderId);
    if (
      !row ||
      row.animeId !== TARGET_ANIME_ID ||
      row.localEpisodeNumber !== number ||
      row.localKind !== "normal" ||
      Number(row.providerEpisodeNumber) !== number
    ) {
      return false;
    }
  }

  const recap = episodeRows.find(
    (row) => row.providerId === EXPECTED_PROVIDER_EPISODE_IDS[12],
  );
  if (
    !recap ||
    recap.animeId !== TARGET_ANIME_ID ||
    recap.localEpisodeNumber !== RECAP_NUMBER ||
    recap.localKind !== "recap" ||
    recap.title !== "Memories" ||
    recap.titleEnglish !== "Memories" ||
    recap.synopsis !== "Summary of Misuzu Kamio's story arc." ||
    recap.airDate !== "2005-04-01" ||
    recap.seasonNumber !== 1 ||
    Number(recap.providerEpisodeNumber) !== RECAP_NUMBER ||
    recap.source !== "system" ||
    recap.confidence < 95
  ) {
    return false;
  }

  const oldOwnerRows = episodeRows.filter((row) => row.animeId === CURRENT_OWNER_ANIME_ID);
  return oldOwnerRows.length === 0;
}

async function verifyAppliedState(
  execute: ExecuteSql,
  plan: AirPlannerOperation,
): Promise<void> {
  if (!(await detectAlreadyApplied(execute))) {
    fail("Post-write AIR state does not satisfy the expected whole-season + recap invariants");
  }

  const [move] = plan.plan.episodeMappingReassignments;
  if (!move) fail("Missing AIR episode reassignment during verification");
  const movedRows = await rowsWith<EpisodeVerificationRow>(execute, sql`
    select
      em.id as "mappingId",
      e.anime_id as "animeId",
      e.id as "episodeId",
      e.number as "localEpisodeNumber",
      e.kind as "localKind",
      e.title,
      e.title_english as "titleEnglish",
      e.synopsis,
      e.air_date as "airDate",
      e.season_number as "seasonNumber",
      em.provider_id as "providerId",
      em.provider_episode_number as "providerEpisodeNumber",
      em.source,
      em.confidence
    from public.episode_mappings em
    join public.episodes e on e.id = em.episode_id
    where em.id = ${move.episodeMappingId}
  `);
  const moved = movedRows[0];
  if (
    movedRows.length !== 1 ||
    !moved ||
    moved.animeId !== TARGET_ANIME_ID ||
    moved.episodeId !== move.toEpisodeId ||
    moved.localEpisodeNumber !== 1 ||
    moved.localKind !== "normal" ||
    moved.providerId !== move.providerEpisodeId ||
    Number(moved.providerEpisodeNumber) !== 1 ||
    moved.source !== move.preserveSource ||
    moved.confidence !== move.preserveConfidence
  ) {
    fail("AIR TVDB episode 1 reassignment did not preserve the exact planned provenance");
  }
}

async function applyPlan(tx: DbTransaction, plan: AirPlannerOperation): Promise<{
  legacyMappingsRetired: number;
  v2AssociationsRetired: number;
  legacyMappingsCreated: number;
  v2AssociationsCreated: number;
  episodeMappingsReassigned: number;
  recapEpisodesCreated: number;
  recapEpisodeMappingsCreated: number;
}> {
  const execute = (query: SQL) => tx.execute(query);
  const [legacy] = plan.plan.retireLegacyMappings;
  const [oldV2] = plan.plan.retireV2Associations;
  const [newLegacy] = plan.plan.createLegacyMappings;
  const [newV2] = plan.plan.createV2Associations;
  const [move] = plan.plan.episodeMappingReassignments;
  const [recapEpisode] = plan.plan.createEpisodes;
  const [recapMapping] = plan.plan.createEpisodeMappings;
  if (!legacy || !oldV2 || !newLegacy || !newV2 || !move || !recapEpisode || !recapMapping) {
    fail("Incomplete AIR recap repair plan");
  }

  const deletedLegacy = await rowsWith<{ id: number }>(execute, sql`
    delete from public.anime_mappings
    where id = ${legacy.id}
      and anime_id = ${CURRENT_OWNER_ANIME_ID}
      and provider = ${PROVIDER}
      and provider_id = ${PROVIDER_ID}
      and source = ${legacy.source}
      and confidence = ${legacy.confidence}
    returning id
  `);
  if (deletedLegacy.length !== 1) fail("Legacy Airs TVDB mapping changed before deletion");

  const deletedV2 = await rowsWith<{ id: number }>(execute, sql`
    delete from public.anime_provider_mappings apm
    where apm.id = ${oldV2.id}
      and apm.anime_id = ${CURRENT_OWNER_ANIME_ID}
      and apm.provider_entity_id = ${plan.providerEntityId}
      and apm.source = ${oldV2.source}
      and apm.confidence = ${oldV2.confidence}
      and not exists (
        select 1 from public.anime_provider_segments aps
        where aps.anime_provider_mapping_id = apm.id
      )
    returning id
  `);
  if (deletedV2.length !== 1) fail("Zero-segment Airs v2 association changed before deletion");

  const insertedLegacy = await rowsWith<{ id: number; animeId: number }>(execute, sql`
    insert into public.anime_mappings
      (anime_id, provider, provider_id, confidence, source, is_primary)
    values (
      ${newLegacy.animeId},
      ${newLegacy.provider},
      ${newLegacy.providerId},
      ${newLegacy.confidence},
      ${newLegacy.source},
      ${newLegacy.isPrimary}
    )
    returning id, anime_id as "animeId"
  `);
  if (insertedLegacy.length !== 1 || insertedLegacy[0]?.animeId !== TARGET_ANIME_ID) {
    fail("Failed to create exact AIR legacy TVDB parent");
  }

  const insertedV2 = await rowsWith<{ id: number; animeId: number }>(execute, sql`
    insert into public.anime_provider_mappings
      (anime_id, provider_entity_id, confidence, source, is_primary)
    values (
      ${newV2.animeId},
      ${newV2.providerEntityId},
      ${newV2.confidence},
      ${newV2.source},
      ${newV2.isPrimary}
    )
    returning id, anime_id as "animeId"
  `);
  if (insertedV2.length !== 1 || insertedV2[0]?.animeId !== TARGET_ANIME_ID) {
    fail("Failed to create exact AIR v2 TVDB parent");
  }

  const reassigned = await rowsWith<{ id: number }>(execute, sql`
    update public.episode_mappings
    set episode_id = ${move.toEpisodeId}, updated_at = now()
    where id = ${move.episodeMappingId}
      and episode_id = ${move.fromEpisodeId}
      and provider = ${PROVIDER}
      and provider_id = ${move.providerEpisodeId}
      and provider_episode_number = ${String(move.providerEpisodeNumber)}
      and source = ${move.preserveSource}
      and confidence = ${move.preserveConfidence}
    returning id
  `);
  if (reassigned.length !== 1) fail("Stolen AIR TVDB episode 1 changed before reassignment");

  const insertedRecap = await rowsWith<{ id: number; animeId: number }>(execute, sql`
    insert into public.episodes
      (
        anime_id,
        number,
        sort_number,
        kind,
        title,
        title_english,
        synopsis,
        air_date,
        season_number
      )
    values (
      ${recapEpisode.animeId},
      ${recapEpisode.number},
      ${recapEpisode.sortNumber},
      ${recapEpisode.kind},
      ${recapEpisode.title},
      ${recapEpisode.titleEnglish},
      ${recapEpisode.synopsis},
      ${recapEpisode.airDate},
      ${recapEpisode.seasonNumber}
    )
    returning id, anime_id as "animeId"
  `);
  const recapEpisodeId = insertedRecap[0]?.id;
  if (
    insertedRecap.length !== 1 ||
    insertedRecap[0]?.animeId !== TARGET_ANIME_ID ||
    !recapEpisodeId
  ) {
    fail("Failed to materialize exact AIR recap episode 13");
  }

  const insertedRecapMapping = await rowsWith<{ id: number }>(execute, sql`
    insert into public.episode_mappings
      (
        episode_id,
        provider,
        provider_id,
        provider_episode_number,
        confidence,
        source
      )
    values (
      ${recapEpisodeId},
      ${recapMapping.provider},
      ${recapMapping.providerEpisodeId},
      ${recapMapping.providerEpisodeNumber},
      ${recapMapping.confidence},
      ${recapMapping.source}
    )
    returning id
  `);
  if (insertedRecapMapping.length !== 1) {
    fail("Failed to create exact AIR recap TVDB episode mapping");
  }

  const counts = {
    legacyMappingsRetired: deletedLegacy.length,
    v2AssociationsRetired: deletedV2.length,
    legacyMappingsCreated: insertedLegacy.length,
    v2AssociationsCreated: insertedV2.length,
    episodeMappingsReassigned: reassigned.length,
    recapEpisodesCreated: insertedRecap.length,
    recapEpisodeMappingsCreated: insertedRecapMapping.length,
  };
  if (
    counts.legacyMappingsRetired !== 1 ||
    counts.v2AssociationsRetired !== 1 ||
    counts.legacyMappingsCreated !== 1 ||
    counts.v2AssociationsCreated !== 1 ||
    counts.episodeMappingsReassigned !== 1 ||
    counts.recapEpisodesCreated !== 1 ||
    counts.recapEpisodeMappingsCreated !== 1
  ) {
    fail(`Applied AIR write counts do not match the exact plan: ${JSON.stringify(counts)}`);
  }

  await verifyAppliedState(execute, plan);
  return counts;
}

async function runApply(): Promise<Record<string, unknown>> {
  let lease: SyncLease | null = null;
  let succeeded = false;
  try {
    lease = await tryAcquireSyncLease();
    if (!lease) {
      fail("Could not acquire the global sync lease; another full sync/repair is active");
    }

    const result = await db.transaction(async (tx) => {
      const execute = (query: SQL) => tx.execute(query);
      await tx.execute(sql`
        lock table
          public.anime_mappings,
          public.provider_entities,
          public.anime_provider_mappings,
          public.anime_provider_segments,
          public.episodes,
          public.episode_mappings
        in share row exclusive mode
      `);

      if (await detectAlreadyApplied(execute)) {
        return {
          alreadyApplied: true,
          plan: null as AirPlannerOperation | null,
          counts: {
            legacyMappingsRetired: 0,
            v2AssociationsRetired: 0,
            legacyMappingsCreated: 0,
            v2AssociationsCreated: 0,
            episodeMappingsReassigned: 0,
            recapEpisodesCreated: 0,
            recapEpisodeMappingsCreated: 0,
          },
        };
      }

      const plan = await runPlanner();
      const counts = await applyPlan(tx, plan);
      return { alreadyApplied: false, plan, counts };
    });

    if (result.plan) {
      await verifyAppliedState((query) => db.execute(query), result.plan);
    } else if (!(await detectAlreadyApplied((query) => db.execute(query)))) {
      fail("Already-applied AIR detection changed unexpectedly after transaction commit");
    }

    succeeded = true;
    return {
      ok: true,
      mode: "apply",
      generatedAt: new Date().toISOString(),
      operation: {
        code: "repair-air-recap-repair",
        provider: PROVIDER,
        providerId: PROVIDER_ID,
        alreadyApplied: result.alreadyApplied,
        applied: result.counts,
        postCommitVerified: true,
      },
    };
  } finally {
    if (lease) await lease.release(succeeded).catch(() => undefined);
  }
}

async function runDryRun(): Promise<Record<string, unknown>> {
  if (await detectAlreadyApplied((query) => db.execute(query))) {
    return {
      ok: true,
      mode: "dry-run",
      generatedAt: new Date().toISOString(),
      operation: {
        code: "repair-air-recap-repair",
        provider: PROVIDER,
        providerId: PROVIDER_ID,
        alreadyApplied: true,
        plannedWrites: 0,
      },
    };
  }

  const plan = await runPlanner();
  return {
    ok: true,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    operation: {
      code: "repair-air-recap-repair",
      description:
        "Dry-run the evidence-backed AIR TVDB correction. Use --apply explicitly to acquire the sync lease and perform the exact transactional repair.",
      provider: plan.provider,
      providerId: plan.providerId,
      providerEntityId: plan.providerEntityId,
      alreadyApplied: false,
      totals: plan.totals,
      plan: plan.plan,
    },
  };
}

if (import.meta.main) {
  try {
    const { mode } = parseRepairMappingsArgs(Bun.argv.slice(2));
    const result = mode === "apply" ? await runApply() : await runDryRun();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
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
