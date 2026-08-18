import { sql, type SQL } from "drizzle-orm";

import {
  closeDb,
  db,
  tryAcquireSyncLease,
  type SyncLease,
} from "@anicore/db";

type Mode = "dry-run" | "apply";

interface CountRow {
  count: number;
}

interface BackfillReport {
  ok: true;
  mode: Mode;
  generatedAt: string;
  operation: {
    code: "backfill-provider-entity-model";
    description: string;
    legacyMappingCount: number;
    distinctProviderEntityCount: number;
    existingProviderEntityCount: number;
    existingAnimeProviderMappingCount: number;
    plannedProviderEntityInsertCount: number;
    plannedAnimeProviderMappingInsertCount: number;
    appliedProviderEntityInsertCount: number;
    appliedAnimeProviderMappingInsertCount: number;
    remainingLegacyMappingsWithoutV2Link: number;
  };
}

function parseMode(args: string[]): Mode {
  let mode: Mode = "dry-run";
  for (const arg of args) {
    if (arg === "--apply") {
      mode = "apply";
      continue;
    }
    if (arg === "--dry-run") {
      mode = "dry-run";
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return mode;
}

async function queryRows<T extends Record<string, unknown>>(
  query: SQL,
): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as T[];
}

async function count(query: SQL): Promise<number> {
  const [row] = await queryRows<CountRow>(query);
  return Number(row?.count ?? 0);
}

async function assertSegmentMappingTablesExist(): Promise<void> {
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

  if (
    !row?.providerEntities ||
    !row.animeProviderMappings ||
    !row.animeProviderSegments
  ) {
    throw new Error(
      "Segment-aware provider mapping tables do not exist yet; run `bun run db:push` before this backfill",
    );
  }
}

async function countLegacyMappings(): Promise<number> {
  return count(sql`
    select count(*)::int as count
    from anime_mappings
    where provider in ('thetvdb', 'tmdb')
  `);
}

async function countDistinctLegacyProviderEntities(): Promise<number> {
  return count(sql`
    select count(*)::int as count
    from (
      select distinct provider, provider_id
      from anime_mappings
      where provider in ('thetvdb', 'tmdb')
    ) legacy_entities
  `);
}

async function countExistingProviderEntities(): Promise<number> {
  return count(sql`
    select count(*)::int as count
    from provider_entities
    where provider in ('thetvdb', 'tmdb')
  `);
}

async function countExistingAnimeProviderMappings(): Promise<number> {
  return count(sql`
    select count(*)::int as count
    from anime_provider_mappings apm
    join provider_entities pe on pe.id = apm.provider_entity_id
    where pe.provider in ('thetvdb', 'tmdb')
  `);
}

async function countLegacyMappingsWithoutV2Link(): Promise<number> {
  return count(sql`
    select count(*)::int as count
    from anime_mappings am
    where am.provider in ('thetvdb', 'tmdb')
      and not exists (
        select 1
        from provider_entities pe
        join anime_provider_mappings apm
          on apm.provider_entity_id = pe.id
        where pe.provider = am.provider
          and pe.provider_id = am.provider_id
          and apm.anime_id = am.anime_id
      )
  `);
}

async function insertProviderEntities(): Promise<number> {
  const rows = await queryRows<{ id: number }>(sql`
    insert into provider_entities (
      provider,
      provider_id,
      provider_slug,
      provider_url,
      created_at,
      updated_at
    )
    select distinct on (am.provider, am.provider_id)
      am.provider,
      am.provider_id,
      am.provider_slug,
      am.provider_url,
      am.created_at,
      am.updated_at
    from anime_mappings am
    where am.provider in ('thetvdb', 'tmdb')
    order by
      am.provider,
      am.provider_id,
      am.is_primary desc,
      am.updated_at desc,
      am.id desc
    on conflict (provider, provider_id) do nothing
    returning id
  `);
  return rows.length;
}

async function insertAnimeProviderMappings(): Promise<number> {
  const rows = await queryRows<{ id: number }>(sql`
    insert into anime_provider_mappings (
      anime_id,
      provider_entity_id,
      confidence,
      source,
      is_primary,
      created_at,
      updated_at
    )
    select
      am.anime_id,
      pe.id,
      am.confidence,
      am.source,
      am.is_primary,
      am.created_at,
      am.updated_at
    from anime_mappings am
    join provider_entities pe
      on pe.provider = am.provider
      and pe.provider_id = am.provider_id
    where am.provider in ('thetvdb', 'tmdb')
    on conflict (anime_id, provider_entity_id) do nothing
    returning id
  `);
  return rows.length;
}

async function run(mode: Mode): Promise<BackfillReport> {
  await assertSegmentMappingTablesExist();

  const [
    legacyMappingCount,
    distinctProviderEntityCount,
    existingProviderEntityCount,
    existingAnimeProviderMappingCount,
    legacyWithoutLinkBefore,
  ] = await Promise.all([
    countLegacyMappings(),
    countDistinctLegacyProviderEntities(),
    countExistingProviderEntities(),
    countExistingAnimeProviderMappings(),
    countLegacyMappingsWithoutV2Link(),
  ]);

  const plannedProviderEntityInsertCount = Math.max(
    0,
    distinctProviderEntityCount - existingProviderEntityCount,
  );
  const plannedAnimeProviderMappingInsertCount = legacyWithoutLinkBefore;

  let appliedProviderEntityInsertCount = 0;
  let appliedAnimeProviderMappingInsertCount = 0;

  if (mode === "apply") {
    await db.transaction(async () => {
      appliedProviderEntityInsertCount = await insertProviderEntities();
      appliedAnimeProviderMappingInsertCount = await insertAnimeProviderMappings();
    });
  }

  const remainingLegacyMappingsWithoutV2Link =
    mode === "apply"
      ? await countLegacyMappingsWithoutV2Link()
      : legacyWithoutLinkBefore;

  if (mode === "apply" && remainingLegacyMappingsWithoutV2Link !== 0) {
    throw new Error(
      `Provider mapping backfill left ${remainingLegacyMappingsWithoutV2Link} legacy TVDB/TMDB mappings without a v2 association`,
    );
  }

  return {
    ok: true,
    mode,
    generatedAt: new Date().toISOString(),
    operation: {
      code: "backfill-provider-entity-model",
      description:
        "Copy existing one-to-one TVDB/TMDB anime mappings into provider_entities and anime_provider_mappings. Legacy anime_mappings remain unchanged; no episode segments are guessed during this compatibility backfill.",
      legacyMappingCount,
      distinctProviderEntityCount,
      existingProviderEntityCount,
      existingAnimeProviderMappingCount,
      plannedProviderEntityInsertCount,
      plannedAnimeProviderMappingInsertCount,
      appliedProviderEntityInsertCount,
      appliedAnimeProviderMappingInsertCount,
      remainingLegacyMappingsWithoutV2Link,
    },
  };
}

if (import.meta.main) {
  const mode = parseMode(Bun.argv.slice(2));
  let lease: SyncLease | null = null;
  let succeeded = false;

  try {
    if (mode === "apply") {
      lease = await tryAcquireSyncLease();
      if (!lease) {
        throw new Error(
          "Another AniCore sync process already holds the database lease; backfill was not started",
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
          `Failed to release provider mapping backfill lease: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exitCode = 1;
      }
    }
    await closeDb().catch(() => undefined);
  }
}
