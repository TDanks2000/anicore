import { sql, type SQL } from "drizzle-orm";

import {
  closeDb,
  db,
  tryAcquireSyncLease,
  type SyncLease,
} from "@anicore/db";

import { parseRepairMappingsArgs } from "./repair-mappings-cli";

const PROVIDER = "thetvdb" as const;
const PROVIDER_ID = "262954:2";
const PREFIX_ANIME_ID = 4013;
const SUFFIX_ANIME_ID = 4356;
const CURRENT_OWNER_ANIME_ID = 6401;
const PREFIX_END = 24;
const SEASON_END = 48;

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

interface NewAssociationPlanRow {
  animeId: number;
  providerEntityId: number;
  source: "system";
  confidence: number;
  isPrimary: boolean;
}

interface NewSegmentPlanRow {
  animeId: number;
  providerEpisodeStart: number;
  providerEpisodeEnd: number;
  localEpisodeStart: number;
  localEpisodeEnd: number;
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
  provider: "thetvdb";
  providerEpisodeId: string;
  providerEpisodeNumber: number;
  animeId: number;
  episodeId: number;
  localEpisodeNumber: number;
  source: "system";
  confidence: number;
}

interface JojoPlannerOperation {
  code: "plan-jojo-segment-migration";
  provider: "thetvdb";
  providerId: string;
  providerEntityId: number;
  plan: {
    retireLegacyMappings: LegacyMappingPlanRow[];
    retireV2Associations: V2AssociationPlanRow[];
    createV2Associations: NewAssociationPlanRow[];
    createSegments: NewSegmentPlanRow[];
    episodeMappingReassignments: EpisodeReassignmentPlanRow[];
    episodeMappingsToCreate: EpisodeCreatePlanRow[];
  };
  totals: {
    legacyMappingsToRetire: number;
    v2AssociationsToRetire: number;
    v2AssociationsToCreate: number;
    segmentsToCreate: number;
    episodeMappingsToReassign: number;
    episodeMappingsToCreate: number;
  };
}

interface JojoPlannerOutput {
  ok: boolean;
  mode: "dry-run";
  operation?: JojoPlannerOperation;
  error?: string;
}

interface AssociationVerificationRow {
  id: number;
  animeId: number;
  providerEntityId: number;
  source: string;
  confidence: number;
  isPrimary: boolean;
  providerEpisodeStart: number | null;
  providerEpisodeEnd: number | null;
  localEpisodeStart: number | null;
  localEpisodeEnd: number | null;
}

interface EpisodeVerificationRow {
  mappingId: number;
  animeId: number;
  episodeId: number;
  localEpisodeNumber: number;
  localKind: string;
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

async function runPlanner(): Promise<JojoPlannerOperation> {
  const script = `${import.meta.dir}/plan-jojo-segment-migration.ts`;
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
      `JoJo migration planner failed with exit code ${exitCode}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  const parsed = JSON.parse(stdout) as JojoPlannerOutput;
  if (!parsed.ok || parsed.mode !== "dry-run" || !parsed.operation) {
    fail(parsed.error ?? "JoJo migration planner did not return a successful dry-run result");
  }
  validatePlan(parsed.operation);
  return parsed.operation;
}

function validatePlan(plan: JojoPlannerOperation): void {
  if (
    plan.code !== "plan-jojo-segment-migration" ||
    plan.provider !== PROVIDER ||
    plan.providerId !== PROVIDER_ID
  ) {
    fail("Planner returned an unexpected provider identity");
  }

  const totals = plan.totals;
  if (
    totals.legacyMappingsToRetire !== 1 ||
    totals.v2AssociationsToRetire !== 1 ||
    totals.v2AssociationsToCreate !== 2 ||
    totals.segmentsToCreate !== 2 ||
    totals.episodeMappingsToReassign !== 1 ||
    totals.episodeMappingsToCreate !== 24
  ) {
    fail(`Planner totals no longer match the proven JoJo migration: ${JSON.stringify(totals)}`);
  }

  const [legacy] = plan.plan.retireLegacyMappings;
  const [oldV2] = plan.plan.retireV2Associations;
  const [move] = plan.plan.episodeMappingReassignments;
  if (
    plan.plan.retireLegacyMappings.length !== 1 ||
    !legacy ||
    legacy.animeId !== CURRENT_OWNER_ANIME_ID ||
    plan.plan.retireV2Associations.length !== 1 ||
    !oldV2 ||
    oldV2.animeId !== CURRENT_OWNER_ANIME_ID ||
    oldV2.segmentCount !== 0 ||
    plan.plan.episodeMappingReassignments.length !== 1 ||
    !move ||
    move.providerEpisodeNumber !== 1 ||
    move.fromAnimeId !== CURRENT_OWNER_ANIME_ID ||
    move.toAnimeId !== PREFIX_ANIME_ID ||
    move.toLocalEpisodeNumber !== 1
  ) {
    fail("Planner ownership state no longer matches the proven JoJo split");
  }

  const associations = [...plan.plan.createV2Associations].sort(
    (a, b) => a.animeId - b.animeId,
  );
  if (
    associations.length !== 2 ||
    associations[0]?.animeId !== PREFIX_ANIME_ID ||
    associations[1]?.animeId !== SUFFIX_ANIME_ID ||
    associations.some(
      (row) =>
        row.providerEntityId !== plan.providerEntityId ||
        row.source !== "system" ||
        row.confidence < 95 ||
        !row.isPrimary,
    )
  ) {
    fail("Planner association creation rows are not the expected two system mappings");
  }

  const segments = [...plan.plan.createSegments].sort(
    (a, b) => a.animeId - b.animeId,
  );
  const prefixSegment = segments.find((row) => row.animeId === PREFIX_ANIME_ID);
  const suffixSegment = segments.find((row) => row.animeId === SUFFIX_ANIME_ID);
  if (
    segments.length !== 2 ||
    !prefixSegment ||
    prefixSegment.providerEpisodeStart !== 1 ||
    prefixSegment.providerEpisodeEnd !== PREFIX_END ||
    prefixSegment.localEpisodeStart !== 1 ||
    prefixSegment.localEpisodeEnd !== PREFIX_END ||
    !suffixSegment ||
    suffixSegment.providerEpisodeStart !== PREFIX_END + 1 ||
    suffixSegment.providerEpisodeEnd !== SEASON_END ||
    suffixSegment.localEpisodeStart !== 1 ||
    suffixSegment.localEpisodeEnd !== SEASON_END - PREFIX_END
  ) {
    fail("Planner segment ranges are not the proven 1..24 and 25..48 -> 1..24 split");
  }

  const suffixRows = [...plan.plan.episodeMappingsToCreate].sort(
    (a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber,
  );
  if (
    suffixRows.length !== 24 ||
    suffixRows.some(
      (row, index) =>
        row.provider !== PROVIDER ||
        row.providerEpisodeNumber !== PREFIX_END + 1 + index ||
        row.animeId !== SUFFIX_ANIME_ID ||
        row.localEpisodeNumber !== index + 1 ||
        row.source !== "system" ||
        row.confidence < 95,
    ) ||
    new Set(suffixRows.map((row) => row.providerEpisodeId)).size !== suffixRows.length ||
    new Set(suffixRows.map((row) => row.episodeId)).size !== suffixRows.length
  ) {
    fail("Planner suffix episode rows are not an exact authoritative 25..48 -> 1..24 mapping");
  }
}

async function detectAlreadyApplied(execute: ExecuteSql): Promise<boolean> {
  const [entity] = await rowsWith<{ id: number }>(execute, sql`
    select id
    from public.provider_entities
    where provider = ${PROVIDER} and provider_id = ${PROVIDER_ID}
  `);
  if (!entity) return false;

  const legacy = await rowsWith<{ id: number }>(execute, sql`
    select id
    from public.anime_mappings
    where provider = ${PROVIDER} and provider_id = ${PROVIDER_ID}
  `);
  if (legacy.length !== 0) return false;

  const associations = await rowsWith<AssociationVerificationRow>(execute, sql`
    select
      apm.id,
      apm.anime_id as "animeId",
      apm.provider_entity_id as "providerEntityId",
      apm.source,
      apm.confidence,
      apm.is_primary as "isPrimary",
      aps.provider_episode_start as "providerEpisodeStart",
      aps.provider_episode_end as "providerEpisodeEnd",
      aps.local_episode_start as "localEpisodeStart",
      aps.local_episode_end as "localEpisodeEnd"
    from public.anime_provider_mappings apm
    join public.provider_entities pe on pe.id = apm.provider_entity_id
    left join public.anime_provider_segments aps
      on aps.anime_provider_mapping_id = apm.id
    where pe.provider = ${PROVIDER}
      and (
        pe.id = ${entity.id}
        or apm.anime_id in (${PREFIX_ANIME_ID}, ${SUFFIX_ANIME_ID}, ${CURRENT_OWNER_ANIME_ID})
      )
    order by apm.anime_id, aps.provider_episode_start
  `);

  if (associations.length !== 2) return false;
  const prefix = associations.find((row) => row.animeId === PREFIX_ANIME_ID);
  const suffix = associations.find((row) => row.animeId === SUFFIX_ANIME_ID);
  if (
    !prefix ||
    prefix.providerEntityId !== entity.id ||
    prefix.source !== "system" ||
    prefix.confidence < 95 ||
    !prefix.isPrimary ||
    prefix.providerEpisodeStart !== 1 ||
    prefix.providerEpisodeEnd !== PREFIX_END ||
    prefix.localEpisodeStart !== 1 ||
    prefix.localEpisodeEnd !== PREFIX_END ||
    !suffix ||
    suffix.providerEntityId !== entity.id ||
    suffix.source !== "system" ||
    suffix.confidence < 95 ||
    !suffix.isPrimary ||
    suffix.providerEpisodeStart !== PREFIX_END + 1 ||
    suffix.providerEpisodeEnd !== SEASON_END ||
    suffix.localEpisodeStart !== 1 ||
    suffix.localEpisodeEnd !== SEASON_END - PREFIX_END
  ) {
    return false;
  }

  const episodeRows = await rowsWith<EpisodeVerificationRow>(execute, sql`
    select
      em.id as "mappingId",
      e.anime_id as "animeId",
      em.episode_id as "episodeId",
      e.number as "localEpisodeNumber",
      e.kind as "localKind",
      em.provider_id as "providerId",
      em.provider_episode_number as "providerEpisodeNumber",
      em.source,
      em.confidence
    from public.episode_mappings em
    join public.episodes e on e.id = em.episode_id
    where em.provider = ${PROVIDER}
      and e.anime_id in (${PREFIX_ANIME_ID}, ${SUFFIX_ANIME_ID}, ${CURRENT_OWNER_ANIME_ID})
    order by e.anime_id, e.number, em.id
  `);
  if (episodeRows.length !== SEASON_END) return false;
  if (episodeRows.some((row) => row.animeId === CURRENT_OWNER_ANIME_ID)) return false;

  const prefixRows = episodeRows.filter((row) => row.animeId === PREFIX_ANIME_ID);
  const suffixRows = episodeRows.filter((row) => row.animeId === SUFFIX_ANIME_ID);
  if (prefixRows.length !== PREFIX_END || suffixRows.length !== SEASON_END - PREFIX_END) {
    return false;
  }
  if (
    prefixRows.some(
      (row) =>
        row.localKind !== "normal" ||
        Number(row.providerEpisodeNumber) !== row.localEpisodeNumber ||
        row.localEpisodeNumber < 1 ||
        row.localEpisodeNumber > PREFIX_END,
    ) ||
    suffixRows.some(
      (row) =>
        row.localKind !== "normal" ||
        Number(row.providerEpisodeNumber) !== PREFIX_END + row.localEpisodeNumber ||
        row.localEpisodeNumber < 1 ||
        row.localEpisodeNumber > SEASON_END - PREFIX_END ||
        row.source !== "system" ||
        row.confidence < 95,
    )
  ) {
    return false;
  }
  return true;
}

async function verifyAppliedState(
  execute: ExecuteSql,
  plan: JojoPlannerOperation,
): Promise<void> {
  if (!(await detectAlreadyApplied(execute))) {
    fail("Post-write segmented JoJo state does not satisfy the expected structural invariants");
  }

  const [move] = plan.plan.episodeMappingReassignments;
  if (!move) fail("Missing planned episode reassignment during verification");
  const moveRows = await rowsWith<EpisodeVerificationRow>(execute, sql`
    select
      em.id as "mappingId",
      e.anime_id as "animeId",
      em.episode_id as "episodeId",
      e.number as "localEpisodeNumber",
      e.kind as "localKind",
      em.provider_id as "providerId",
      em.provider_episode_number as "providerEpisodeNumber",
      em.source,
      em.confidence
    from public.episode_mappings em
    join public.episodes e on e.id = em.episode_id
    where em.id = ${move.episodeMappingId}
  `);
  const moved = moveRows[0];
  if (
    moveRows.length !== 1 ||
    !moved ||
    moved.animeId !== PREFIX_ANIME_ID ||
    moved.episodeId !== move.toEpisodeId ||
    moved.localEpisodeNumber !== 1 ||
    moved.providerId !== move.providerEpisodeId ||
    Number(moved.providerEpisodeNumber) !== 1 ||
    moved.source !== move.preserveSource ||
    moved.confidence !== move.preserveConfidence
  ) {
    fail("Reassigned provider episode 1 did not preserve the exact planned mapping/provenance");
  }

  for (const expected of plan.plan.episodeMappingsToCreate) {
    const matches = await rowsWith<EpisodeVerificationRow>(execute, sql`
      select
        em.id as "mappingId",
        e.anime_id as "animeId",
        em.episode_id as "episodeId",
        e.number as "localEpisodeNumber",
        e.kind as "localKind",
        em.provider_id as "providerId",
        em.provider_episode_number as "providerEpisodeNumber",
        em.source,
        em.confidence
      from public.episode_mappings em
      join public.episodes e on e.id = em.episode_id
      where em.provider = ${PROVIDER} and em.provider_id = ${expected.providerEpisodeId}
    `);
    const row = matches[0];
    if (
      matches.length !== 1 ||
      !row ||
      row.animeId !== SUFFIX_ANIME_ID ||
      row.episodeId !== expected.episodeId ||
      row.localEpisodeNumber !== expected.localEpisodeNumber ||
      Number(row.providerEpisodeNumber) !== expected.providerEpisodeNumber ||
      row.source !== "system" ||
      row.confidence < 95
    ) {
      fail(`Created suffix provider episode ${expected.providerEpisodeNumber} failed exact verification`);
    }
  }
}

async function applyPlan(tx: DbTransaction, plan: JojoPlannerOperation): Promise<{
  legacyMappingsRetired: number;
  v2AssociationsRetired: number;
  v2AssociationsCreated: number;
  segmentsCreated: number;
  episodeMappingsReassigned: number;
  episodeMappingsCreated: number;
}> {
  const execute = (query: SQL) => tx.execute(query);

  const [legacy] = plan.plan.retireLegacyMappings;
  const [oldV2] = plan.plan.retireV2Associations;
  const [move] = plan.plan.episodeMappingReassignments;
  if (!legacy || !oldV2 || !move) fail("Incomplete JoJo migration plan");

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
  if (deletedLegacy.length !== 1) fail("Legacy Phantom Blood mapping changed before deletion");

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
  if (deletedV2.length !== 1) fail("Zero-segment Phantom Blood v2 association changed before deletion");

  const createdAssociations = new Map<number, number>();
  for (const association of plan.plan.createV2Associations) {
    const inserted = await rowsWith<{ id: number; animeId: number }>(execute, sql`
      insert into public.anime_provider_mappings
        (anime_id, provider_entity_id, confidence, source, is_primary)
      values (
        ${association.animeId},
        ${association.providerEntityId},
        ${association.confidence},
        ${association.source},
        ${association.isPrimary}
      )
      returning id, anime_id as "animeId"
    `);
    if (inserted.length !== 1 || inserted[0]?.animeId !== association.animeId) {
      fail(`Failed to create exact v2 association for anime ${association.animeId}`);
    }
    createdAssociations.set(association.animeId, inserted[0]!.id);
  }

  let segmentsCreated = 0;
  for (const segment of plan.plan.createSegments) {
    const associationId = createdAssociations.get(segment.animeId);
    if (!associationId) fail(`Missing new association for segment anime ${segment.animeId}`);
    const inserted = await rowsWith<{ id: number }>(execute, sql`
      insert into public.anime_provider_segments
        (
          anime_provider_mapping_id,
          provider_episode_start,
          provider_episode_end,
          local_episode_start,
          local_episode_end
        )
      values (
        ${associationId},
        ${segment.providerEpisodeStart},
        ${segment.providerEpisodeEnd},
        ${segment.localEpisodeStart},
        ${segment.localEpisodeEnd}
      )
      returning id
    `);
    if (inserted.length !== 1) fail(`Failed to create segment for anime ${segment.animeId}`);
    segmentsCreated += 1;
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
  if (reassigned.length !== 1) fail("Stolen TVDB episode 1 changed before reassignment");

  let episodeMappingsCreated = 0;
  for (const mapping of plan.plan.episodeMappingsToCreate) {
    const inserted = await rowsWith<{ id: number }>(execute, sql`
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
        ${mapping.episodeId},
        ${mapping.provider},
        ${mapping.providerEpisodeId},
        ${String(mapping.providerEpisodeNumber)},
        ${mapping.confidence},
        ${mapping.source}
      )
      returning id
    `);
    if (inserted.length !== 1) {
      fail(`Failed to insert suffix provider episode ${mapping.providerEpisodeNumber}`);
    }
    episodeMappingsCreated += 1;
  }

  const counts = {
    legacyMappingsRetired: deletedLegacy.length,
    v2AssociationsRetired: deletedV2.length,
    v2AssociationsCreated: createdAssociations.size,
    segmentsCreated,
    episodeMappingsReassigned: reassigned.length,
    episodeMappingsCreated,
  };
  if (
    counts.legacyMappingsRetired !== 1 ||
    counts.v2AssociationsRetired !== 1 ||
    counts.v2AssociationsCreated !== 2 ||
    counts.segmentsCreated !== 2 ||
    counts.episodeMappingsReassigned !== 1 ||
    counts.episodeMappingsCreated !== 24
  ) {
    fail(`Applied write counts do not match the exact plan: ${JSON.stringify(counts)}`);
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
          plan: null as JojoPlannerOperation | null,
          counts: {
            legacyMappingsRetired: 0,
            v2AssociationsRetired: 0,
            v2AssociationsCreated: 0,
            segmentsCreated: 0,
            episodeMappingsReassigned: 0,
            episodeMappingsCreated: 0,
          },
        };
      }

      // Re-run all external/provider/date/relation and current-state evidence while
      // mapping-table writes are blocked, then mutate exactly that proven state.
      const plan = await runPlanner();
      const counts = await applyPlan(tx, plan);
      return { alreadyApplied: false, plan, counts };
    });

    if (result.plan) {
      await verifyAppliedState((query) => db.execute(query), result.plan);
    } else if (!(await detectAlreadyApplied((query) => db.execute(query)))) {
      fail("Already-applied detection changed unexpectedly after transaction commit");
    }

    succeeded = true;
    return {
      ok: true,
      mode: "apply",
      generatedAt: new Date().toISOString(),
      operation: {
        code: "repair-jojo-segment-migration",
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
        code: "repair-jojo-segment-migration",
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
      code: "repair-jojo-segment-migration",
      description:
        "Dry-run the evidence-backed JoJo TVDB split repair. Use --apply explicitly to acquire the sync lease and perform the exact transactional plan.",
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
