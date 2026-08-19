import { sql, type SQL } from "drizzle-orm";

import { closeDb, db } from "@anicore/db";
import { getTvdbSeasonEpisodes } from "@anicore/providers/thetvdb/client";

const PROVIDER = "thetvdb" as const;
const PROVIDER_ID = "79101:1";
const SERIES_ID = 79101;
const SEASON_NUMBER = 1;
const TARGET_ANIME_ID = 223;
const CURRENT_OWNER_ANIME_ID = 13285;
const RECAP_NUMBER = 13;

type MappingSource = "manual" | "api" | "import" | "fuzzy" | "system";

interface ProviderEntityRow { id: number }
interface LegacyMappingRow { id: number; animeId: number; source: MappingSource; confidence: number; isPrimary: boolean }
interface V2AssociationRow { id: number; animeId: number; source: MappingSource; confidence: number; isPrimary: boolean; segmentCount: number }
interface LocalEpisodeRow { id: number; animeId: number; number: number; kind: string }
interface EpisodeMappingRow { id: number; animeId: number; episodeId: number; localEpisodeNumber: number; localKind: string; providerId: string; providerEpisodeNumber: string | null; source: MappingSource; confidence: number }
interface AuthoritativeEpisode { providerEpisodeId: string; providerEpisodeNumber: number; title: string | null; overview: string | null; airDate: string | null; seasonNumber: number | null }

async function queryRows<T>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as unknown as T[];
}

function fail(message: string): never { throw new Error(message) }

function isSafelyRetirableAutomaticMapping(input: { source: MappingSource; confidence: number }): boolean {
  return input.source === "fuzzy" || (input.source === "api" && input.confidence <= 85);
}

function assertExactRange(numbers: number[], start: number, end: number, label: string): void {
  const sorted = [...numbers].sort((a, b) => a - b);
  const expected = Array.from({ length: end - start + 1 }, (_, index) => start + index);
  if (sorted.length !== expected.length || sorted.some((value, index) => value !== expected[index])) {
    fail(`${label} must contain exactly ${start}..${end}; got [${sorted.join(", ")}]`);
  }
}

async function run(): Promise<Record<string, unknown>> {
  if (!process.env.TVDB_API_KEY?.trim()) fail("TVDB_API_KEY is required for the AIR recap repair planner");

  const authoritative = (await getTvdbSeasonEpisodes(SERIES_ID, SEASON_NUMBER, "eng"))
    .filter((episode) => Number.isInteger(episode.id) && episode.id > 0 && Number.isInteger(episode.number) && (episode.number ?? 0) > 0)
    .map<AuthoritativeEpisode>((episode) => ({
      providerEpisodeId: String(episode.id),
      providerEpisodeNumber: episode.number!,
      title: episode.name?.trim() || null,
      overview: episode.overview?.trim() || null,
      airDate: episode.aired?.trim() || null,
      seasonNumber: episode.seasonNumber ?? null,
    }))
    .sort((a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber);

  assertExactRange(authoritative.map((episode) => episode.providerEpisodeNumber), 1, RECAP_NUMBER, "AIR TVDB season 1");
  if (new Set(authoritative.map((episode) => episode.providerEpisodeId)).size !== authoritative.length) fail("AIR TVDB season contains duplicate provider episode IDs");

  const recap = authoritative.find((episode) => episode.providerEpisodeNumber === RECAP_NUMBER);
  if (!recap) fail("AIR TVDB recap episode 13 is missing");
  if (
    recap.title?.trim().toLowerCase() !== "memories" ||
    !/summary\s+of\s+misuzu\s+kamio'?s\s+story\s+arc/i.test(recap.overview ?? "") ||
    recap.airDate !== "2005-04-01" ||
    recap.seasonNumber !== 1
  ) {
    fail(`TVDB episode 13 no longer matches the proven AIR recap evidence: title=${recap.title} airDate=${recap.airDate} season=${recap.seasonNumber}`);
  }

  const providerEntities = await queryRows<ProviderEntityRow>(sql`
    select id from public.provider_entities where provider = ${PROVIDER} and provider_id = ${PROVIDER_ID}
  `);
  if (providerEntities.length !== 1) fail(`Expected exactly one provider entity for ${PROVIDER}:${PROVIDER_ID}`);
  const providerEntityId = providerEntities[0]!.id;

  const legacyMappings = await queryRows<LegacyMappingRow>(sql`
    select id, anime_id as "animeId", source, confidence, is_primary as "isPrimary"
    from public.anime_mappings
    where provider = ${PROVIDER} and provider_id = ${PROVIDER_ID}
  `);
  if (legacyMappings.length !== 1) fail(`Expected exactly one legacy owner for ${PROVIDER}:${PROVIDER_ID}`);
  const legacyOwner = legacyMappings[0]!;
  if (legacyOwner.animeId !== CURRENT_OWNER_ANIME_ID || !isSafelyRetirableAutomaticMapping(legacyOwner)) {
    fail(`Legacy AIR TVDB owner is not the expected safely-retirable Airs mapping: anime=${legacyOwner.animeId} source=${legacyOwner.source} confidence=${legacyOwner.confidence}`);
  }

  const targetLegacy = await queryRows<{ id: number }>(sql`
    select id from public.anime_mappings where anime_id = ${TARGET_ANIME_ID} and provider = ${PROVIDER}
  `);
  if (targetLegacy.length !== 0) fail("AIR already has a legacy TVDB mapping; refusing to plan around mixed state");

  const v2Associations = await queryRows<V2AssociationRow>(sql`
    select apm.id, apm.anime_id as "animeId", apm.source, apm.confidence, apm.is_primary as "isPrimary", count(aps.id)::int as "segmentCount"
    from public.anime_provider_mappings apm
    left join public.anime_provider_segments aps on aps.anime_provider_mapping_id = apm.id
    where apm.provider_entity_id = ${providerEntityId}
    group by apm.id
    order by apm.id
  `);
  if (v2Associations.length !== 1) fail(`Expected exactly one current v2 association for ${PROVIDER}:${PROVIDER_ID}`);
  const v2Owner = v2Associations[0]!;
  if (v2Owner.animeId !== CURRENT_OWNER_ANIME_ID || v2Owner.segmentCount !== 0 || !isSafelyRetirableAutomaticMapping(v2Owner)) {
    fail(`V2 AIR TVDB owner is not the expected safely-retirable Airs association: anime=${v2Owner.animeId} segments=${v2Owner.segmentCount} source=${v2Owner.source} confidence=${v2Owner.confidence}`);
  }

  const targetV2 = await queryRows<{ id: number }>(sql`
    select apm.id
    from public.anime_provider_mappings apm
    join public.provider_entities pe on pe.id = apm.provider_entity_id
    where apm.anime_id = ${TARGET_ANIME_ID} and pe.provider = ${PROVIDER}
  `);
  if (targetV2.length !== 0) fail("AIR already has a v2 TVDB association; refusing to plan around mixed state");

  const localEpisodes = await queryRows<LocalEpisodeRow>(sql`
    select id, anime_id as "animeId", number, kind
    from public.episodes
    where anime_id = ${TARGET_ANIME_ID}
    order by kind, number, id
  `);
  const normalEpisodes = localEpisodes.filter((episode) => episode.kind === "normal");
  assertExactRange(normalEpisodes.map((episode) => episode.number), 1, 12, "AIR normal local episodes");
  if (localEpisodes.some((episode) => episode.number === RECAP_NUMBER)) fail("AIR already has a local episode numbered 13; refusing duplicate materialization");
  const normalByNumber = new Map(normalEpisodes.map((episode) => [episode.number, episode]));

  const providerIds = authoritative.map((episode) => episode.providerEpisodeId);
  const episodeMappings = await queryRows<EpisodeMappingRow>(sql`
    select em.id, e.anime_id as "animeId", em.episode_id as "episodeId", e.number as "localEpisodeNumber", e.kind as "localKind",
           em.provider_id as "providerId", em.provider_episode_number as "providerEpisodeNumber", em.source, em.confidence
    from public.episode_mappings em
    join public.episodes e on e.id = em.episode_id
    where em.provider = ${PROVIDER}
      and em.provider_id in (${sql.join(providerIds.map((id) => sql`${id}`), sql`, `)})
    order by em.id
  `);
  const byProviderId = new Map(episodeMappings.map((mapping) => [mapping.providerId, mapping]));
  if (byProviderId.size !== episodeMappings.length) fail("Duplicate TVDB provider episode IDs exist in AIR season scope");

  let reassignment: Record<string, unknown> | null = null;
  for (const authoritativeEpisode of authoritative) {
    const number = authoritativeEpisode.providerEpisodeNumber;
    const current = byProviderId.get(authoritativeEpisode.providerEpisodeId) ?? null;
    if (number === 1) {
      const target = normalByNumber.get(1)!;
      if (!current || current.animeId !== CURRENT_OWNER_ANIME_ID || current.localEpisodeNumber !== 1 || current.localKind !== "normal" || Number(current.providerEpisodeNumber) !== 1) {
        fail("AIR TVDB episode 1 is no longer the expected stolen Airs mapping");
      }
      reassignment = {
        episodeMappingId: current.id,
        providerEpisodeId: authoritativeEpisode.providerEpisodeId,
        providerEpisodeNumber: 1,
        fromAnimeId: current.animeId,
        fromEpisodeId: current.episodeId,
        toAnimeId: TARGET_ANIME_ID,
        toEpisodeId: target.id,
        toLocalEpisodeNumber: 1,
        preserveSource: current.source,
        preserveConfidence: current.confidence,
      };
      continue;
    }
    if (number <= 12) {
      const target = normalByNumber.get(number)!;
      if (!current || current.animeId !== TARGET_ANIME_ID || current.episodeId !== target.id || current.localEpisodeNumber !== number || current.localKind !== "normal" || Number(current.providerEpisodeNumber) !== number) {
        fail(`AIR TVDB episode ${number} is no longer mapped exactly to AIR normal ${number}`);
      }
      continue;
    }
    if (current) fail("AIR TVDB recap episode 13 is already mapped; expected it to be unmapped");
  }
  if (!reassignment) fail("Expected one AIR episode mapping reassignment");

  return {
    ok: true,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    operation: {
      code: "plan-air-recap-repair",
      description: "Plan the verified AIR TVDB correction without writing: retire the bogus Airs parent, promote AIR as the whole-season parent, move TVDB episode 1, and materialize TVDB episode 13 as a recap rather than a normal episode.",
      provider: PROVIDER,
      providerId: PROVIDER_ID,
      providerEntityId,
      evidence: {
        targetAnimeId: TARGET_ANIME_ID,
        currentOwnerAnimeId: CURRENT_OWNER_ANIME_ID,
        normalEpisodeRange: [1, 12],
        recap: {
          providerEpisodeId: recap.providerEpisodeId,
          providerEpisodeNumber: recap.providerEpisodeNumber,
          title: recap.title,
          overview: recap.overview,
          airDate: recap.airDate,
          seasonNumber: recap.seasonNumber,
          localKind: "recap",
          localEpisodeNumber: RECAP_NUMBER,
        },
      },
      plan: {
        retireLegacyMappings: [legacyOwner],
        retireV2Associations: [v2Owner],
        createLegacyMappings: [{ animeId: TARGET_ANIME_ID, provider: PROVIDER, providerId: PROVIDER_ID, source: "system", confidence: 95, isPrimary: true }],
        createV2Associations: [{ animeId: TARGET_ANIME_ID, providerEntityId, source: "system", confidence: 95, isPrimary: true }],
        episodeMappingReassignments: [reassignment],
        createEpisodes: [{ animeId: TARGET_ANIME_ID, number: RECAP_NUMBER, sortNumber: RECAP_NUMBER, kind: "recap", title: recap.title, titleEnglish: recap.title, synopsis: recap.overview, airDate: recap.airDate, seasonNumber: recap.seasonNumber }],
        createEpisodeMappings: [{ provider: PROVIDER, providerEpisodeId: recap.providerEpisodeId, providerEpisodeNumber: String(RECAP_NUMBER), source: "system", confidence: 95 }],
      },
      totals: {
        legacyMappingsToRetire: 1,
        v2AssociationsToRetire: 1,
        legacyMappingsToCreate: 1,
        v2AssociationsToCreate: 1,
        episodeMappingsToReassign: 1,
        recapEpisodesToCreate: 1,
        recapEpisodeMappingsToCreate: 1,
      },
    },
  };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length > 0) fail(`This planner is dry-run only and accepts no arguments; received: ${args.join(" ")}`);
    console.log(JSON.stringify(await run(), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, mode: "dry-run", error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  } finally {
    await closeDb().catch(() => undefined);
  }
}
