import { TMDB } from "@api-wrappers/tmdb-wrapper";
import { sql, type SQL } from "drizzle-orm";

import { closeDb, db } from "@anicore/db";
import { getTvdbSeasonEpisodes } from "@anicore/providers/thetvdb/client";

import { analyzeSuffixSegmentEvidence } from "./provider-suffix-segment-evidence";

type Provider = "thetvdb" | "tmdb";

interface StrongPrefixSample {
  provider: Provider;
  providerId: string;
  targetAnimeId: number;
  targetTitle: string | null;
  targetEpisodeCount: number | null;
  currentOwnerAnimeId: number;
  currentOwnerTitle: string | null;
  authoritativeEpisodeCount: number;
  prefix: {
    ok: boolean;
    providerEpisodeEnd: number | null;
  };
}

interface PrefixDiagnosticOutput {
  ok: boolean;
  operation?: {
    strongSamples?: StrongPrefixSample[];
  };
}

interface EpisodeMappingRow {
  provider: Provider;
  providerEpisodeId: string;
  animeId: number;
  localEpisodeNumber: number;
  localKind: string;
}

interface LocalNormalEpisodeRow {
  animeId: number;
  episodeNumber: number;
}

interface AnimeMetaRow {
  animeId: number;
  titleRomaji: string;
  format: string | null;
  episodeCount: number | null;
  startDate: string | null;
  endDate: string | null;
}

interface RelationRow {
  animeId: number;
  relatedAnimeId: number;
  relationType: string;
}

interface AuthoritativeEpisode {
  providerEpisodeId: string;
  providerEpisodeNumber: number;
  airDate: string | null;
}

async function queryRows<T extends Record<string, unknown>>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as T[];
}

function identityKey(provider: string, providerEpisodeId: string): string {
  return `${provider}\u0000${providerEpisodeId}`;
}

function parseProviderIdentity(providerId: string): {
  entityId: number;
  seasonNumber: number;
} | null {
  const [entityIdRaw, seasonNumberRaw, ...rest] = providerId.split(":");
  if (rest.length > 0 || !entityIdRaw || !seasonNumberRaw) return null;
  const entityId = Number(entityIdRaw);
  const seasonNumber = Number(seasonNumberRaw);
  if (!Number.isInteger(entityId) || entityId <= 0) return null;
  if (!Number.isInteger(seasonNumber) || seasonNumber <= 0) return null;
  return { entityId, seasonNumber };
}

async function runPrefixDiagnostic(): Promise<StrongPrefixSample[]> {
  const script = `${import.meta.dir}/diagnose-provider-prefix-segment-evidence.ts`;
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
    throw new Error(
      `Prefix diagnostic failed with exit code ${exitCode}: ${stderr.trim() || stdout.trim()}`,
    );
  }
  const parsed = JSON.parse(stdout) as PrefixDiagnosticOutput;
  if (!parsed.ok || !parsed.operation) {
    throw new Error("Prefix diagnostic did not return a successful operation result");
  }
  return (parsed.operation.strongSamples ?? []).filter(
    (sample) => sample.prefix.ok && Number.isInteger(sample.prefix.providerEpisodeEnd),
  );
}

async function loadEpisodeMappings(): Promise<EpisodeMappingRow[]> {
  return queryRows<EpisodeMappingRow>(sql`
    select
      em.provider,
      em.provider_id as "providerEpisodeId",
      e.anime_id as "animeId",
      e.number as "localEpisodeNumber",
      e.kind as "localKind"
    from public.episode_mappings em
    join public.episodes e on e.id = em.episode_id
    where em.provider in ('thetvdb', 'tmdb')
    order by em.provider, em.provider_id
  `);
}

async function loadLocalNormalEpisodes(): Promise<LocalNormalEpisodeRow[]> {
  return queryRows<LocalNormalEpisodeRow>(sql`
    select anime_id as "animeId", number as "episodeNumber"
    from public.episodes
    where kind = 'normal'
    order by anime_id, number
  `);
}

async function loadAnimeMeta(): Promise<AnimeMetaRow[]> {
  return queryRows<AnimeMetaRow>(sql`
    select
      id as "animeId",
      title_romaji as "titleRomaji",
      format,
      episode_count as "episodeCount",
      start_date as "startDate",
      end_date as "endDate"
    from public.anime
    order by id
  `);
}

async function loadRelations(): Promise<RelationRow[]> {
  return queryRows<RelationRow>(sql`
    select
      anime_id as "animeId",
      related_anime_id as "relatedAnimeId",
      relation_type as "relationType"
    from public.anime_relation_links
    order by anime_id, related_anime_id
  `);
}

function directRelationIds(targetAnimeId: number, relations: RelationRow[]): Set<number> {
  const result = new Set<number>();
  for (const relation of relations) {
    if (relation.animeId === targetAnimeId) result.add(relation.relatedAnimeId);
    if (relation.relatedAnimeId === targetAnimeId) result.add(relation.animeId);
  }
  return result;
}

function relationTypesBetween(
  left: number,
  right: number,
  relations: RelationRow[],
): string[] {
  return [
    ...new Set(
      relations
        .filter(
          (relation) =>
            (relation.animeId === left && relation.relatedAnimeId === right) ||
            (relation.animeId === right && relation.relatedAnimeId === left),
        )
        .map((relation) => relation.relationType),
    ),
  ].sort();
}

async function getAuthoritativeSeason(
  provider: Provider,
  providerId: string,
  getTmdb: () => TMDB,
): Promise<AuthoritativeEpisode[]> {
  const parsed = parseProviderIdentity(providerId);
  if (!parsed) throw new Error(`Malformed ${provider} provider ID: ${providerId}`);

  if (provider === "thetvdb") {
    const episodes = await getTvdbSeasonEpisodes(parsed.entityId, parsed.seasonNumber, "eng");
    return episodes
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
  }

  const season = await getTmdb().tvSeasons.details(
    { tvShowID: parsed.entityId, seasonNumber: parsed.seasonNumber },
    undefined,
    { language: "en-US" },
  );
  return (season.episodes ?? [])
    .filter(
      (episode) =>
        Number.isInteger(episode.id) &&
        episode.id > 0 &&
        Number.isInteger(episode.episode_number) &&
        episode.episode_number > 0,
    )
    .map((episode) => ({
      providerEpisodeId: String(episode.id),
      providerEpisodeNumber: episode.episode_number,
      airDate: episode.air_date?.trim() || null,
    }))
    .sort((a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber);
}

async function run(): Promise<Record<string, unknown>> {
  const strongPrefixes = await runPrefixDiagnostic();
  const [episodeRows, localRows, animeRows, relations] = await Promise.all([
    loadEpisodeMappings(),
    loadLocalNormalEpisodes(),
    loadAnimeMeta(),
    loadRelations(),
  ]);

  if (strongPrefixes.some((sample) => sample.provider === "thetvdb") && !process.env.TVDB_API_KEY?.trim()) {
    throw new Error("TVDB_API_KEY is required for suffix segment evidence diagnosis");
  }
  if (strongPrefixes.some((sample) => sample.provider === "tmdb") && !process.env.TMDB_API_KEY?.trim()) {
    throw new Error("TMDB_API_KEY is required for suffix segment evidence diagnosis");
  }

  let tmdb: TMDB | null = null;
  const getTmdb = (): TMDB => {
    if (!tmdb) {
      const apiKey = process.env.TMDB_API_KEY?.trim();
      if (!apiKey) throw new Error("TMDB_API_KEY is required");
      tmdb = new TMDB({ apiKey });
    }
    return tmdb;
  };

  const mappingByEpisodeIdentity = new Map<string, EpisodeMappingRow>();
  for (const row of episodeRows) {
    mappingByEpisodeIdentity.set(identityKey(row.provider, row.providerEpisodeId), row);
  }
  const localNumbersByAnime = new Map<number, number[]>();
  for (const row of localRows) {
    const values = localNumbersByAnime.get(row.animeId) ?? [];
    values.push(row.episodeNumber);
    localNumbersByAnime.set(row.animeId, values);
  }
  const metaByAnime = new Map(animeRows.map((row) => [row.animeId, row]));

  const samples = [] as Array<Record<string, unknown>>;
  for (const prefixSample of strongPrefixes) {
    const prefixEnd = prefixSample.prefix.providerEpisodeEnd!;
    const authoritative = await getAuthoritativeSeason(
      prefixSample.provider,
      prefixSample.providerId,
      getTmdb,
    );
    const suffixEpisodes = authoritative.filter(
      (episode) => episode.providerEpisodeNumber > prefixEnd,
    );
    const mappedSuffix = suffixEpisodes.flatMap((episode) => {
      const mapped = mappingByEpisodeIdentity.get(
        identityKey(prefixSample.provider, episode.providerEpisodeId),
      );
      return mapped
        ? [
            {
              providerEpisodeNumber: episode.providerEpisodeNumber,
              animeId: mapped.animeId,
              localEpisodeNumber: mapped.localEpisodeNumber,
              localKind: mapped.localKind,
            },
          ]
        : [];
    });

    const relatedIds = directRelationIds(prefixSample.targetAnimeId, relations);
    const candidateIds = new Set<number>([
      ...relatedIds,
      prefixSample.currentOwnerAnimeId,
      ...mappedSuffix.map((mapping) => mapping.animeId),
    ]);
    candidateIds.delete(prefixSample.targetAnimeId);

    const animeCandidates = [...candidateIds].flatMap((animeId) => {
      const meta = metaByAnime.get(animeId);
      if (!meta) return [];
      return [
        {
          animeId,
          episodeCount: meta.episodeCount,
          localNormalEpisodeNumbers: localNumbersByAnime.get(animeId) ?? [],
          startDate: meta.startDate,
          endDate: meta.endDate,
          directlyRelatedToTarget: relatedIds.has(animeId),
        },
      ];
    });

    const suffix = analyzeSuffixSegmentEvidence({
      authoritativeEpisodes: authoritative.map((episode) => ({
        providerEpisodeNumber: episode.providerEpisodeNumber,
        airDate: episode.airDate,
      })),
      prefixEnd,
      mappedEpisodes: mappedSuffix,
      animeCandidates,
      currentOwnerAnimeId: prefixSample.currentOwnerAnimeId,
    });

    const candidateDetails = suffix.candidateEvidence.map((candidate) => {
      const meta = metaByAnime.get(candidate.animeId);
      return {
        ...candidate,
        title: meta?.titleRomaji ?? null,
        format: meta?.format ?? null,
        episodeCount: meta?.episodeCount ?? null,
        startDate: meta?.startDate ?? null,
        endDate: meta?.endDate ?? null,
        relationTypes: relationTypesBetween(
          prefixSample.targetAnimeId,
          candidate.animeId,
          relations,
        ),
      };
    });

    samples.push({
      provider: prefixSample.provider,
      providerId: prefixSample.providerId,
      targetAnimeId: prefixSample.targetAnimeId,
      targetTitle: prefixSample.targetTitle,
      prefixEnd,
      authoritativeEpisodeCount: authoritative.length,
      currentOwnerAnimeId: prefixSample.currentOwnerAnimeId,
      currentOwnerTitle: prefixSample.currentOwnerTitle,
      suffix: {
        ...suffix,
        candidateEvidence: candidateDetails,
      },
      mappedSuffixEpisodes: mappedSuffix,
    });
  }

  const exactMapped = samples.filter(
    (sample) =>
      (sample.suffix as { exactMappedSuffixAnimeId: number | null }).exactMappedSuffixAnimeId !== null,
  );
  const uniqueRelated = samples.filter(
    (sample) =>
      (sample.suffix as { uniqueRelatedSuffixCandidateAnimeId: number | null })
        .uniqueRelatedSuffixCandidateAnimeId !== null,
  );
  const currentOwnerMatches = samples.filter(
    (sample) =>
      (sample.suffix as { currentOwnerMatchesSuffixMetadata: boolean })
        .currentOwnerMatchesSuffixMetadata,
  );

  return {
    ok: true,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    operation: {
      code: "diagnose-provider-suffix-segment-evidence",
      description:
        "For the strict prefix segments already proven by diagnose-provider-prefix-segment-evidence, inspect the authoritative provider suffix N+1..seasonEnd. Report existing provider-episode ownership, exact non-zero provider-to-local suffix mappings, and unique directly-related AniList candidates whose episode count, local 1..M coverage, and start/end dates match the provider suffix. Diagnostic-only; no writes.",
      strongPrefixGroups: strongPrefixes.length,
      exactMappedSuffixGroups: exactMapped.length,
      uniqueRelatedSuffixCandidateGroups: uniqueRelated.length,
      currentOwnerMatchesSuffixMetadataGroups: currentOwnerMatches.length,
      samples,
    },
  };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length > 0) {
      throw new Error(
        `This command is diagnostic-only and accepts no arguments; received: ${args.join(" ")}`,
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
