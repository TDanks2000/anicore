import { sql, type SQL } from "drizzle-orm";

import { closeDb, db } from "@anicore/db";
import { getTvdbSeasonEpisodes } from "@anicore/providers/thetvdb/client";

const PROVIDER = "thetvdb" as const;
const PROVIDER_ID = "262954:2";
const SERIES_ID = 262954;
const SEASON_NUMBER = 2;
const PREFIX_ANIME_ID = 4013;
const SUFFIX_ANIME_ID = 4356;
const CURRENT_OWNER_ANIME_ID = 6401;
const PREFIX_END = 24;
const SEASON_END = 48;

type MappingSource = "manual" | "api" | "import" | "fuzzy" | "system";

interface SuffixCandidateEvidence {
  animeId: number;
  episodeCountMatches: boolean;
  localCoverageMatches: boolean;
  boundaryDatesMatch: boolean;
  directlyRelatedToTarget: boolean;
  startDateDeltaDays: number | null;
  endDateDeltaDays: number | null;
  title?: string | null;
}

interface SuffixSample {
  provider: string;
  providerId: string;
  targetAnimeId: number;
  prefixEnd: number;
  authoritativeEpisodeCount: number;
  currentOwnerAnimeId: number;
  suffix: {
    suffixStart: number;
    suffixEnd: number;
    suffixEpisodeCount: number;
    mappedSuffixEpisodeCount: number;
    mappedSuffixAnimeIds: number[];
    exactMappedSuffixAnimeId: number | null;
    uniqueRelatedSuffixCandidateAnimeId: number | null;
    currentOwnerMatchesSuffixMetadata: boolean;
    candidateEvidence: SuffixCandidateEvidence[];
  };
}

interface SuffixDiagnosticOutput {
  ok: boolean;
  mode?: string;
  operation?: {
    samples?: SuffixSample[];
  };
}

interface ProviderEntityRow {
  id: number;
  provider: string;
  providerId: string;
}

interface LegacyMappingRow {
  id: number;
  animeId: number;
  source: MappingSource;
  confidence: number;
  isPrimary: boolean;
}

interface V2AssociationRow {
  id: number;
  animeId: number;
  source: MappingSource;
  confidence: number;
  isPrimary: boolean;
  segmentCount: number;
}

interface LocalEpisodeRow {
  id: number;
  animeId: number;
  number: number;
  kind: string;
}

interface EpisodeMappingRow {
  id: number;
  animeId: number;
  episodeId: number;
  localEpisodeNumber: number;
  localKind: string;
  providerId: string;
  providerEpisodeNumber: string | null;
  source: MappingSource;
  confidence: number;
}

interface AuthoritativeEpisode {
  providerEpisodeId: string;
  providerEpisodeNumber: number;
  airDate: string | null;
}

async function queryRows<T>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as unknown as T[];
}

function fail(message: string): never {
  throw new Error(message);
}

function assertExactRange(numbers: number[], start: number, end: number, label: string): void {
  const sorted = [...numbers].sort((a, b) => a - b);
  const expected = Array.from({ length: end - start + 1 }, (_, index) => start + index);
  if (
    sorted.length !== expected.length ||
    sorted.some((value, index) => value !== expected[index])
  ) {
    fail(`${label} must contain exactly ${start}..${end}; got [${sorted.join(", ")}]`);
  }
}

function isSafelyRetirableAutomaticMapping(input: {
  source: MappingSource;
  confidence: number;
}): boolean {
  return input.source === "fuzzy" || (input.source === "api" && input.confidence <= 85);
}

async function runSuffixDiagnostic(): Promise<SuffixSample> {
  const script = `${import.meta.dir}/diagnose-provider-suffix-segment-evidence.ts`;
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
      `Suffix evidence diagnostic failed with exit code ${exitCode}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  const parsed = JSON.parse(stdout) as SuffixDiagnosticOutput;
  if (!parsed.ok || parsed.mode !== "dry-run" || !parsed.operation) {
    fail("Suffix evidence diagnostic did not return a successful dry-run result");
  }
  const matches = (parsed.operation.samples ?? []).filter(
    (sample) =>
      sample.provider === PROVIDER &&
      sample.providerId === PROVIDER_ID &&
      sample.targetAnimeId === PREFIX_ANIME_ID,
  );
  if (matches.length !== 1) {
    fail(`Expected exactly one JoJo suffix evidence sample; got ${matches.length}`);
  }
  const sample = matches[0]!;
  if (
    sample.prefixEnd !== PREFIX_END ||
    sample.authoritativeEpisodeCount !== SEASON_END ||
    sample.currentOwnerAnimeId !== CURRENT_OWNER_ANIME_ID ||
    sample.suffix.suffixStart !== PREFIX_END + 1 ||
    sample.suffix.suffixEnd !== SEASON_END ||
    sample.suffix.suffixEpisodeCount !== SEASON_END - PREFIX_END ||
    sample.suffix.mappedSuffixEpisodeCount !== 0 ||
    sample.suffix.mappedSuffixAnimeIds.length !== 0 ||
    sample.suffix.exactMappedSuffixAnimeId !== null ||
    sample.suffix.uniqueRelatedSuffixCandidateAnimeId !== SUFFIX_ANIME_ID ||
    sample.suffix.currentOwnerMatchesSuffixMetadata
  ) {
    fail("JoJo suffix evidence no longer matches the proven 1..24 + 25..48 split");
  }
  const suffixCandidate = sample.suffix.candidateEvidence.find(
    (candidate) => candidate.animeId === SUFFIX_ANIME_ID,
  );
  if (
    !suffixCandidate ||
    !suffixCandidate.episodeCountMatches ||
    !suffixCandidate.localCoverageMatches ||
    !suffixCandidate.boundaryDatesMatch ||
    !suffixCandidate.directlyRelatedToTarget
  ) {
    fail("Egypt-hen no longer satisfies the strict related-suffix evidence checks");
  }
  return sample;
}

async function loadAuthoritativeSeason(): Promise<AuthoritativeEpisode[]> {
  if (!process.env.TVDB_API_KEY?.trim()) {
    fail("TVDB_API_KEY is required for the JoJo segment migration planner");
  }
  const rows = await getTvdbSeasonEpisodes(SERIES_ID, SEASON_NUMBER, "eng");
  const episodes = rows
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
      airDate: episode.aired?.trim() || null,
    }))
    .sort((a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber);

  assertExactRange(
    episodes.map((episode) => episode.providerEpisodeNumber),
    1,
    SEASON_END,
    "Authoritative TVDB season 2",
  );
  if (new Set(episodes.map((episode) => episode.providerEpisodeId)).size !== episodes.length) {
    fail("Authoritative TVDB season contains duplicate provider episode IDs");
  }
  return episodes;
}

async function run(): Promise<Record<string, unknown>> {
  const evidence = await runSuffixDiagnostic();
  const authoritative = await loadAuthoritativeSeason();

  const providerEntities = await queryRows<ProviderEntityRow>(sql`
    select id, provider, provider_id as "providerId"
    from public.provider_entities
    where provider = ${PROVIDER} and provider_id = ${PROVIDER_ID}
  `);
  if (providerEntities.length !== 1) {
    fail(`Expected exactly one canonical provider entity for ${PROVIDER}:${PROVIDER_ID}`);
  }
  const providerEntity = providerEntities[0]!;

  const legacyMappings = await queryRows<LegacyMappingRow>(sql`
    select id, anime_id as "animeId", source, confidence, is_primary as "isPrimary"
    from public.anime_mappings
    where provider = ${PROVIDER} and provider_id = ${PROVIDER_ID}
  `);
  if (legacyMappings.length !== 1) {
    fail(`Expected exactly one legacy owner for ${PROVIDER}:${PROVIDER_ID}`);
  }
  const legacyOwner = legacyMappings[0]!;
  if (
    legacyOwner.animeId !== CURRENT_OWNER_ANIME_ID ||
    !isSafelyRetirableAutomaticMapping(legacyOwner)
  ) {
    fail(
      `Legacy JoJo season owner is not the expected safely-retirable automatic mapping: anime=${legacyOwner.animeId} source=${legacyOwner.source} confidence=${legacyOwner.confidence}`,
    );
  }

  const targetLegacyMappings = await queryRows<LegacyMappingRow>(sql`
    select id, anime_id as "animeId", source, confidence, is_primary as "isPrimary"
    from public.anime_mappings
    where provider = ${PROVIDER}
      and anime_id in (${PREFIX_ANIME_ID}, ${SUFFIX_ANIME_ID})
  `);
  if (targetLegacyMappings.length !== 0) {
    fail("Stardust Crusaders or Egypt-hen already has a legacy TVDB mapping; refusing mixed legacy/segment migration");
  }

  const v2EntityAssociations = await queryRows<V2AssociationRow>(sql`
    select
      apm.id,
      apm.anime_id as "animeId",
      apm.source,
      apm.confidence,
      apm.is_primary as "isPrimary",
      count(aps.id)::int as "segmentCount"
    from public.anime_provider_mappings apm
    left join public.anime_provider_segments aps
      on aps.anime_provider_mapping_id = apm.id
    where apm.provider_entity_id = ${providerEntity.id}
    group by apm.id
    order by apm.id
  `);
  if (v2EntityAssociations.length !== 1) {
    fail(`Expected exactly one existing v2 association for ${PROVIDER}:${PROVIDER_ID}`);
  }
  const v2Owner = v2EntityAssociations[0]!;
  if (
    v2Owner.animeId !== CURRENT_OWNER_ANIME_ID ||
    v2Owner.segmentCount !== 0 ||
    !isSafelyRetirableAutomaticMapping(v2Owner)
  ) {
    fail(
      `Existing v2 owner is not the expected zero-segment safely-retirable association: anime=${v2Owner.animeId} segments=${v2Owner.segmentCount} source=${v2Owner.source} confidence=${v2Owner.confidence}`,
    );
  }

  const targetV2ProviderAssociations = await queryRows<{ id: number; animeId: number; providerId: string }>(sql`
    select apm.id, apm.anime_id as "animeId", pe.provider_id as "providerId"
    from public.anime_provider_mappings apm
    join public.provider_entities pe on pe.id = apm.provider_entity_id
    where pe.provider = ${PROVIDER}
      and apm.anime_id in (${PREFIX_ANIME_ID}, ${SUFFIX_ANIME_ID})
  `);
  if (targetV2ProviderAssociations.length !== 0) {
    fail("Stardust Crusaders or Egypt-hen already has a v2 TVDB association; refusing to guess around existing state");
  }

  const localEpisodes = await queryRows<LocalEpisodeRow>(sql`
    select id, anime_id as "animeId", number, kind
    from public.episodes
    where anime_id in (${PREFIX_ANIME_ID}, ${SUFFIX_ANIME_ID})
      and kind = 'normal'
    order by anime_id, number
  `);
  const prefixEpisodes = localEpisodes.filter((episode) => episode.animeId === PREFIX_ANIME_ID);
  const suffixEpisodes = localEpisodes.filter((episode) => episode.animeId === SUFFIX_ANIME_ID);
  assertExactRange(prefixEpisodes.map((episode) => episode.number), 1, PREFIX_END, "Stardust local episodes");
  assertExactRange(suffixEpisodes.map((episode) => episode.number), 1, SEASON_END - PREFIX_END, "Egypt-hen local episodes");
  const prefixEpisodeByNumber = new Map(prefixEpisodes.map((episode) => [episode.number, episode]));
  const suffixEpisodeByNumber = new Map(suffixEpisodes.map((episode) => [episode.number, episode]));

  const relevantEpisodeMappings = await queryRows<EpisodeMappingRow>(sql`
    select
      em.id,
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
    order by em.id
  `);

  const authoritativeById = new Map(
    authoritative.map((episode) => [episode.providerEpisodeId, episode]),
  );
  const outsideSeasonMappings = relevantEpisodeMappings.filter(
    (mapping) => !authoritativeById.has(mapping.providerId),
  );
  if (outsideSeasonMappings.length > 0) {
    fail(
      `One of the three involved anime has other TVDB episode mappings outside ${PROVIDER_ID}; refusing provider-scope retirement`,
    );
  }

  const currentByProviderId = new Map(
    relevantEpisodeMappings.map((mapping) => [mapping.providerId, mapping]),
  );
  if (currentByProviderId.size !== relevantEpisodeMappings.length) {
    fail("Duplicate TVDB provider episode IDs exist in the JoJo migration scope");
  }

  const episodeMappingReassignments: Array<Record<string, unknown>> = [];
  const episodeMappingsToCreate: Array<Record<string, unknown>> = [];

  for (const authoritativeEpisode of authoritative) {
    const providerNumber = authoritativeEpisode.providerEpisodeNumber;
    const current = currentByProviderId.get(authoritativeEpisode.providerEpisodeId) ?? null;

    if (providerNumber <= PREFIX_END) {
      const targetEpisode = prefixEpisodeByNumber.get(providerNumber)!;
      if (providerNumber === 1) {
        if (
          !current ||
          current.animeId !== CURRENT_OWNER_ANIME_ID ||
          current.localEpisodeNumber !== 1 ||
          current.localKind !== "normal" ||
          Number(current.providerEpisodeNumber) !== providerNumber
        ) {
          fail("TVDB season 2 episode 1 is no longer the expected stolen Phantom Blood mapping");
        }
        episodeMappingReassignments.push({
          episodeMappingId: current.id,
          providerEpisodeId: authoritativeEpisode.providerEpisodeId,
          providerEpisodeNumber: providerNumber,
          fromAnimeId: current.animeId,
          fromEpisodeId: current.episodeId,
          toAnimeId: PREFIX_ANIME_ID,
          toEpisodeId: targetEpisode.id,
          toLocalEpisodeNumber: targetEpisode.number,
          preserveSource: current.source,
          preserveConfidence: current.confidence,
        });
      } else if (
        !current ||
        current.animeId !== PREFIX_ANIME_ID ||
        current.episodeId !== targetEpisode.id ||
        current.localEpisodeNumber !== providerNumber ||
        current.localKind !== "normal" ||
        Number(current.providerEpisodeNumber) !== providerNumber
      ) {
        fail(`TVDB season 2 episode ${providerNumber} is no longer mapped exactly to Stardust local ${providerNumber}`);
      }
      continue;
    }

    if (current) {
      fail(`TVDB season 2 suffix episode ${providerNumber} is already mapped; expected an unmapped authoritative suffix`);
    }
    const localNumber = providerNumber - PREFIX_END;
    const targetEpisode = suffixEpisodeByNumber.get(localNumber)!;
    episodeMappingsToCreate.push({
      provider: PROVIDER,
      providerEpisodeId: authoritativeEpisode.providerEpisodeId,
      providerEpisodeNumber: providerNumber,
      animeId: SUFFIX_ANIME_ID,
      episodeId: targetEpisode.id,
      localEpisodeNumber: targetEpisode.number,
      source: "system",
      confidence: 95,
    });
  }

  if (episodeMappingReassignments.length !== 1 || episodeMappingsToCreate.length !== 24) {
    fail(
      `Expected exactly 1 reassignment and 24 new suffix episode mappings; got ${episodeMappingReassignments.length} and ${episodeMappingsToCreate.length}`,
    );
  }

  const suffixEvidence = evidence.suffix.candidateEvidence.find(
    (candidate) => candidate.animeId === SUFFIX_ANIME_ID,
  )!;

  return {
    ok: true,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    operation: {
      code: "plan-jojo-segment-migration",
      description:
        "Plan the single fully-evidenced TVDB split discovered by the prefix/suffix diagnostics. This command is read-only and performs no database writes.",
      provider: PROVIDER,
      providerId: PROVIDER_ID,
      providerEntityId: providerEntity.id,
      evidence: {
        prefixAnimeId: PREFIX_ANIME_ID,
        prefixProviderRange: [1, PREFIX_END],
        prefixLocalRange: [1, PREFIX_END],
        suffixAnimeId: SUFFIX_ANIME_ID,
        suffixProviderRange: [PREFIX_END + 1, SEASON_END],
        suffixLocalRange: [1, SEASON_END - PREFIX_END],
        suffixCandidateTitle: suffixEvidence.title ?? null,
        suffixStartDateDeltaDays: suffixEvidence.startDateDeltaDays,
        suffixEndDateDeltaDays: suffixEvidence.endDateDeltaDays,
        directlyRelated: suffixEvidence.directlyRelatedToTarget,
        authoritativeEpisodeCount: authoritative.length,
      },
      currentState: {
        legacyOwner,
        v2Owner,
        existingAuthoritativeEpisodeMappings: relevantEpisodeMappings.length,
        prefixExistingMappings: PREFIX_END,
        suffixExistingMappings: 0,
      },
      plan: {
        retireLegacyMappings: [legacyOwner],
        retireV2Associations: [v2Owner],
        createV2Associations: [
          {
            animeId: PREFIX_ANIME_ID,
            providerEntityId: providerEntity.id,
            source: "system",
            confidence: 95,
            isPrimary: true,
          },
          {
            animeId: SUFFIX_ANIME_ID,
            providerEntityId: providerEntity.id,
            source: "system",
            confidence: 95,
            isPrimary: true,
          },
        ],
        createSegments: [
          {
            animeId: PREFIX_ANIME_ID,
            providerEpisodeStart: 1,
            providerEpisodeEnd: PREFIX_END,
            localEpisodeStart: 1,
            localEpisodeEnd: PREFIX_END,
          },
          {
            animeId: SUFFIX_ANIME_ID,
            providerEpisodeStart: PREFIX_END + 1,
            providerEpisodeEnd: SEASON_END,
            localEpisodeStart: 1,
            localEpisodeEnd: SEASON_END - PREFIX_END,
          },
        ],
        episodeMappingReassignments,
        episodeMappingsToCreate,
      },
      totals: {
        legacyMappingsToRetire: 1,
        v2AssociationsToRetire: 1,
        v2AssociationsToCreate: 2,
        segmentsToCreate: 2,
        episodeMappingsToReassign: episodeMappingReassignments.length,
        episodeMappingsToCreate: episodeMappingsToCreate.length,
      },
    },
  };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length > 0) {
      fail(
        `This command is dry-run only and accepts no arguments; received: ${args.join(" ")}`,
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