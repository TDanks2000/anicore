import { sql, type SQL } from "drizzle-orm";

import { closeDb, db } from "@anicore/db";

import {
  AmbiguousMappingEvidenceSource,
  mapWithConcurrency,
  type AuthoritativeSeasonResult,
} from "./ambiguous-provider-mapping-evidence";
import {
  planAmbiguousMappingRepair,
  type AmbiguousMappingCandidateState,
  type AmbiguousMappingGroupState,
  type AmbiguousMappingLegacyRow,
  type AmbiguousMappingMappedEpisodeRow,
  type AmbiguousMappingPlanResult,
  type AmbiguousMappingProviderEntityRow,
  type AmbiguousMappingV2AssociationRow,
} from "./ambiguous-provider-mapping-plan";

interface AnimeIdentityRow extends Record<string, unknown> {
  animeId: number;
  titleRomaji: string;
  titleEnglish: string | null;
  titleNative: string | null;
  titleUserPreferred: string | null;
  synonymsJson: string;
  episodeCount: number | null;
  startDate: string | null;
  format: string | null;
  seasonYear: number | null;
}

interface V2AssociationQueryRow extends Record<string, unknown> {
  id: number;
  animeId: number;
  providerEntityId: number;
  provider: string;
  providerId: string;
  source: string;
  confidence: number;
  isPrimary: boolean;
  segmentCount: number;
}

async function queryRows<T>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as T[];
}

function sqlIn(values: Array<number | string>): SQL {
  return sql`(${sql.join(values.map((value) => sql`${value}`), sql`, `)})`;
}

async function loadAnimeIdentityRows(animeIds: number[]): Promise<AnimeIdentityRow[]> {
  if (animeIds.length === 0) return [];
  return queryRows<AnimeIdentityRow>(sql`
    select
      id as "animeId",
      title_romaji as "titleRomaji",
      title_english as "titleEnglish",
      title_native as "titleNative",
      title_user_preferred as "titleUserPreferred",
      synonyms_json as "synonymsJson",
      episode_count as "episodeCount",
      start_date as "startDate",
      format,
      season_year as "seasonYear"
    from public.anime
    where id in ${sqlIn(animeIds)}
  `);
}

async function loadLegacyRows(animeIds: number[]): Promise<AmbiguousMappingLegacyRow[]> {
  if (animeIds.length === 0) return [];
  return queryRows<AmbiguousMappingLegacyRow>(sql`
    select
      id,
      anime_id as "animeId",
      provider,
      provider_id as "providerId",
      provider_slug as "providerSlug",
      source,
      confidence,
      is_primary as "isPrimary"
    from public.anime_mappings
    where anime_id in ${sqlIn(animeIds)}
      and provider in ('thetvdb', 'tmdb')
    order by id
  `);
}

async function loadProviderEntities(
  providerIds: string[],
): Promise<AmbiguousMappingProviderEntityRow[]> {
  if (providerIds.length === 0) return [];
  return queryRows<AmbiguousMappingProviderEntityRow>(sql`
    select
      id,
      provider,
      provider_id as "providerId",
      provider_slug as "providerSlug",
      provider_url as "providerUrl"
    from public.provider_entities
    where provider in ('thetvdb', 'tmdb')
      and provider_id in ${sqlIn(providerIds)}
    order by id
  `);
}

async function loadV2Associations(animeIds: number[]): Promise<V2AssociationQueryRow[]> {
  if (animeIds.length === 0) return [];
  return queryRows<V2AssociationQueryRow>(sql`
    select
      apm.id,
      apm.anime_id as "animeId",
      apm.provider_entity_id as "providerEntityId",
      pe.provider,
      pe.provider_id as "providerId",
      apm.source,
      apm.confidence,
      apm.is_primary as "isPrimary",
      (
        select count(*)::int
        from public.anime_provider_segments s
        where s.anime_provider_mapping_id = apm.id
      ) as "segmentCount"
    from public.anime_provider_mappings apm
    join public.provider_entities pe on pe.id = apm.provider_entity_id
    where apm.anime_id in ${sqlIn(animeIds)}
      and pe.provider in ('thetvdb', 'tmdb')
    order by pe.provider, pe.provider_id, apm.id
  `);
}

async function loadMappedProviderEpisodes(
  provider: string,
  providerEpisodeIds: string[],
): Promise<AmbiguousMappingMappedEpisodeRow[]> {
  if (providerEpisodeIds.length === 0) return [];
  return queryRows<AmbiguousMappingMappedEpisodeRow>(sql`
    select
      em.id as "episodeMappingId",
      em.episode_id as "episodeId",
      e.anime_id as "animeId",
      e.number as "localEpisodeNumber",
      e.kind as "localKind",
      em.provider_id as "providerEpisodeId",
      em.provider_episode_number as "providerEpisodeNumber",
      em.source,
      em.confidence
    from public.episode_mappings em
    join public.episodes e on e.id = em.episode_id
    where em.provider = ${provider}
      and em.provider_id in ${sqlIn(providerEpisodeIds)}
    order by em.id
  `);
}

async function run(): Promise<Record<string, unknown>> {
  const source = new AmbiguousMappingEvidenceSource({
    tvdbApiKey: process.env.TVDB_API_KEY?.trim(),
    tmdbApiKey: process.env.TMDB_API_KEY?.trim(),
  });

  const { groups, ambiguousMappings } = await source.diagnoseGroups();
  const repairSafeGroups = groups.filter((group) => group.repairSafe);
  const animeIds = repairSafeGroups.map((group) => group.animeId);

  const [animeIdentityRows, legacyRows, entityRows, v2Rows] = await Promise.all([
    loadAnimeIdentityRows(animeIds),
    loadLegacyRows(animeIds),
    loadProviderEntities(
      repairSafeGroups.flatMap((group) => group.candidates.map((candidate) => candidate.providerId)),
    ),
    loadV2Associations(animeIds),
  ]);

  const identityByAnimeId = new Map(animeIdentityRows.map((row) => [row.animeId, row]));
  const legacyByKey = new Map<string, AmbiguousMappingLegacyRow[]>();
  for (const row of legacyRows) {
    const key = `${row.provider}:${row.providerId}:${row.animeId}`;
    const list = legacyByKey.get(key) ?? [];
    list.push(row);
    legacyByKey.set(key, list);
  }
  const entitiesByKey = new Map<string, AmbiguousMappingProviderEntityRow[]>();
  for (const row of entityRows) {
    const key = `${row.provider}:${row.providerId}`;
    const list = entitiesByKey.get(key) ?? [];
    list.push(row);
    entitiesByKey.set(key, list);
  }
  const v2ByAnimeProvider = new Map<string, V2AssociationQueryRow[]>();
  for (const row of v2Rows) {
    const key = `${row.animeId}:${row.provider}`;
    const list = v2ByAnimeProvider.get(key) ?? [];
    list.push(row);
    v2ByAnimeProvider.set(key, list);
  }

  const candidateStates = await mapWithConcurrency(
    repairSafeGroups.flatMap((group) =>
      group.candidates.map((candidate) => ({
        animeId: group.animeId,
        provider: candidate.provider,
        providerId: candidate.providerId,
      })),
    ),
    4,
    async (candidate): Promise<{ key: string; state: AmbiguousMappingCandidateState }> => {
      const authoritative: AuthoritativeSeasonResult =
        await source.authoritativeSeasonEpisodes(candidate.provider, candidate.providerId);
      const mappedProviderEpisodes = await loadMappedProviderEpisodes(
        candidate.provider,
        authoritative.episodes.map((episode) => episode.providerEpisodeId),
      );
      const key = `${candidate.animeId}:${candidate.provider}:${candidate.providerId}`;
      return {
        key,
        state: {
          provider: candidate.provider,
          providerId: candidate.providerId,
          legacyRows: legacyByKey.get(`${candidate.provider}:${candidate.providerId}:${candidate.animeId}`) ?? [],
          entities: entitiesByKey.get(`${candidate.provider}:${candidate.providerId}`) ?? [],
          v2Associations:
            v2ByAnimeProvider
              .get(`${candidate.animeId}:${candidate.provider}`)
              ?.filter(
                (row) => row.providerId === candidate.providerId,
              )
              .map<AmbiguousMappingV2AssociationRow>((row) => ({
                id: row.id,
                animeId: row.animeId,
                providerEntityId: row.providerEntityId,
                source: row.source,
                confidence: row.confidence,
                isPrimary: row.isPrimary,
                segmentCount: row.segmentCount,
              })) ?? [],
          authoritativeState: authoritative.state,
          authoritativeEpisodes: authoritative.episodes,
          mappedProviderEpisodes,
        },
      };
    },
  );
  const stateByKey = new Map(candidateStates.map((entry) => [entry.key, entry.state]));

  const plans: AmbiguousMappingPlanResult[] = [];
  for (const group of repairSafeGroups) {
    const provider = group.candidates[0]!.provider;
    const state: AmbiguousMappingGroupState = {
      animeId: group.animeId,
      candidates: group.candidates.map(
        (candidate) => stateByKey.get(`${group.animeId}:${candidate.provider}:${candidate.providerId}`)!,
      ),
      sameProviderV2Associations: (v2ByAnimeProvider.get(`${group.animeId}:${provider}`) ?? [])
        .map<AmbiguousMappingV2AssociationRow>((row) => ({
          id: row.id,
          animeId: row.animeId,
          providerEntityId: row.providerEntityId,
          source: row.source,
          confidence: row.confidence,
          isPrimary: row.isPrimary,
          segmentCount: row.segmentCount,
        })),
    };
    plans.push(planAmbiguousMappingRepair({ group, state }));
  }

  const byBlockReason = new Map<string, number>();
  for (const plan of plans) {
    if (plan.blockReason) {
      byBlockReason.set(plan.blockReason, (byBlockReason.get(plan.blockReason) ?? 0) + 1);
    }
  }

  const groupsFullyPlannable = plans.filter((plan) => plan.plannable).length;
  const groupsBlocked = plans.length - groupsFullyPlannable;
  const legacyMappingsToRetire = plans.reduce(
    (sum, plan) => sum + (plan.proposedWrites?.legacyMappingsToRetire.length ?? 0),
    0,
  );
  const v2AssociationsToRetire = plans.reduce(
    (sum, plan) => sum + (plan.proposedWrites?.v2AssociationsToRetire.length ?? 0),
    0,
  );
  const legacyMappingsToUpdate = plans.reduce(
    (sum, plan) => sum + (plan.proposedWrites?.legacyMappingsToUpdate.length ?? 0),
    0,
  );
  const v2AssociationsToUpdate = plans.reduce(
    (sum, plan) => sum + (plan.proposedWrites?.v2AssociationsToUpdate.length ?? 0),
    0,
  );
  const retireProviderEpisodeMappingsFound = plans.reduce(
    (sum, plan) => sum + plan.episodeScope.retireMappedEpisodeCount,
    0,
  );

  return {
    ok: true,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    operation: {
      code: "plan-repair-safe-ambiguous-provider-mappings",
      description:
        "Plan parent-level repairs for ambiguous TVDB/TMDB mapping groups that the live fail-closed diagnosis marks repairSafe (one verified-keep, all siblings verified-retire). Re-runs the authoritative diagnosis dynamically, re-fetches authoritative episode IDs for every keep and retire season, and inspects episode_mappings for wrong-provider episode ownership before proposing any write. Proposed writes are parent-level only: retire the wrong automatic legacy anime_mappings and their matching zero-segment automatic v2 associations, keep the verified rows, and upgrade the verified legacy mapping and v2 association to source=system / confidence=95 / isPrimary=true with old and proposed provenance reported explicitly. Provider entities are never deleted and episode_mappings are never touched. Fails closed on any fetch failure, incomplete authoritative season, manual mapping, explicit segment, identity mismatch, duplicate ownership, keep/retire episode ID overlap, unhandled same-provider v2 associations, or any mapped provider episode owned by a retire season. This command never writes data.",
      summary: {
        repairSafeGroupsSeen: repairSafeGroups.length,
        groupsFullyPlannable,
        groupsBlocked,
        legacyMappingsToRetire,
        v2AssociationsToRetire,
        legacyMappingsToUpdate,
        v2AssociationsToUpdate,
        retireProviderEpisodeMappingsFound,
        blockedByReason: Object.fromEntries(
          [...byBlockReason.entries()].sort(([a], [b]) => a.localeCompare(b)),
        ),
      },
      ambiguousMappings,
      groups: plans.map((plan) => {
        const group = repairSafeGroups.find((candidate) => candidate.animeId === plan.animeId)!;
        return {
          animeIdentity: identityByAnimeId.get(plan.animeId) ?? null,
          verifiedKeep: {
            provider: plan.keep.provider,
            providerId: plan.keep.providerId,
            providerUrl: plan.keep.providerUrl,
            source: plan.keep.source,
            confidence: plan.keep.confidence,
            isPrimary: plan.keep.isPrimary,
            classification: plan.keep.classification,
            repair: plan.keep.repair,
            evidence: plan.keep.evidence,
            signal: plan.keep.signal,
          },
          verifiedRetirees: plan.retirees.map((candidate) => ({
            provider: candidate.provider,
            providerId: candidate.providerId,
            providerUrl: candidate.providerUrl,
            source: candidate.source,
            confidence: candidate.confidence,
            isPrimary: candidate.isPrimary,
            classification: candidate.classification,
            repair: candidate.repair,
            evidence: candidate.evidence,
            signal: candidate.signal,
          })),
          existingRows: {
            legacyMappings: group.candidates.flatMap((candidate) =>
              (stateByKey.get(`${group.animeId}:${candidate.provider}:${candidate.providerId}`)?.legacyRows ?? []).map(
                (row) => ({ ...row }),
              ),
            ),
            providerEntities: group.candidates.flatMap((candidate) =>
              (stateByKey.get(`${group.animeId}:${candidate.provider}:${candidate.providerId}`)?.entities ?? []).map(
                (row) => ({ ...row }),
              ),
            ),
            v2Associations: group.candidates.flatMap((candidate) =>
              (stateByKey.get(`${group.animeId}:${candidate.provider}:${candidate.providerId}`)?.v2Associations ?? []).map(
                (row) => ({ ...row }),
              ),
            ),
            mappedProviderEpisodes: group.candidates.flatMap((candidate) =>
              (stateByKey.get(`${group.animeId}:${candidate.provider}:${candidate.providerId}`)?.mappedProviderEpisodes ?? []).map(
                (row) => ({ ...row }),
              ),
            ),
          },
          episodeScope: plan.episodeScope,
          proposedWrites: plan.proposedWrites,
          blockReason: plan.blockReason,
        };
      }),
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