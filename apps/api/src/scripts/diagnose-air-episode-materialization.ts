import { sql, type SQL } from "drizzle-orm";

import { closeDb, db } from "@anicore/db";
import { fetchAnilistAnime } from "@anicore/providers/anilist/sync";
import { fetchKitsuEpisodeData } from "@anicore/providers/kitsu/sync";
import { getTvdbSeasonEpisodes } from "@anicore/providers/thetvdb/client";

const ANIME_ID = 223;
const TVDB_SERIES_ID = 79101;
const TVDB_SEASON_NUMBER = 1;
const TVDB_PROVIDER_ID = `${TVDB_SERIES_ID}:${TVDB_SEASON_NUMBER}`;

type MappingSource = "manual" | "api" | "import" | "fuzzy" | "system";

interface AnimeRow {
  id: number;
  titleRomaji: string;
  titleEnglish: string | null;
  format: string | null;
  episodeCount: number | null;
  startDate: string | null;
  endDate: string | null;
}

interface AnimeMappingRow {
  id: number;
  provider: string;
  providerId: string;
  source: MappingSource;
  confidence: number;
  isPrimary: boolean;
}

interface LocalEpisodeRow {
  id: number;
  number: number;
  kind: string;
  title: string | null;
  titleEnglish: string | null;
  airDate: string | null;
}

interface EpisodeOwnerRow {
  episodeMappingId: number;
  providerEpisodeId: string;
  providerEpisodeNumber: string | null;
  animeId: number;
  episodeId: number;
  localEpisodeNumber: number;
  localKind: string;
  animeTitle: string;
  source: MappingSource;
  confidence: number;
}

interface ProviderAssociationRow {
  associationId: number;
  animeId: number;
  animeTitle: string;
  source: MappingSource;
  confidence: number;
  isPrimary: boolean;
  segmentCount: number;
}

async function queryRows<T>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as unknown as T[];
}

function fail(message: string): never {
  throw new Error(message);
}

function exactRange(numbers: number[]): { contiguousFromOne: boolean; missing: number[] } {
  const positive = [...new Set(numbers.filter((value) => Number.isInteger(value) && value > 0))]
    .sort((a, b) => a - b);
  const max = positive.at(-1) ?? 0;
  const missing: number[] = [];
  for (let number = 1; number <= max; number += 1) {
    if (!positive.includes(number)) missing.push(number);
  }
  return { contiguousFromOne: missing.length === 0, missing };
}

async function run(): Promise<Record<string, unknown>> {
  if (!process.env.TVDB_API_KEY?.trim()) {
    fail("TVDB_API_KEY is required for the AIR materialization diagnostic");
  }

  const [animeRows, mappings, localEpisodes, providerAssociations] = await Promise.all([
    queryRows<AnimeRow>(sql`
      select
        id,
        title_romaji as "titleRomaji",
        title_english as "titleEnglish",
        format,
        episode_count as "episodeCount",
        start_date as "startDate",
        end_date as "endDate"
      from public.anime
      where id = ${ANIME_ID}
    `),
    queryRows<AnimeMappingRow>(sql`
      select
        id,
        provider,
        provider_id as "providerId",
        source,
        confidence,
        is_primary as "isPrimary"
      from public.anime_mappings
      where anime_id = ${ANIME_ID}
      order by provider, is_primary desc, confidence desc, id
    `),
    queryRows<LocalEpisodeRow>(sql`
      select
        id,
        number,
        kind,
        title,
        title_english as "titleEnglish",
        air_date as "airDate"
      from public.episodes
      where anime_id = ${ANIME_ID}
      order by kind, number, id
    `),
    queryRows<ProviderAssociationRow>(sql`
      select
        apm.id as "associationId",
        apm.anime_id as "animeId",
        a.title_romaji as "animeTitle",
        apm.source,
        apm.confidence,
        apm.is_primary as "isPrimary",
        count(aps.id)::int as "segmentCount"
      from public.provider_entities pe
      join public.anime_provider_mappings apm on apm.provider_entity_id = pe.id
      join public.anime a on a.id = apm.anime_id
      left join public.anime_provider_segments aps
        on aps.anime_provider_mapping_id = apm.id
      where pe.provider = 'thetvdb'
        and pe.provider_id = ${TVDB_PROVIDER_ID}
      group by apm.id, a.title_romaji
      order by apm.anime_id, apm.id
    `),
  ]);

  if (animeRows.length !== 1) {
    fail(`Expected exactly one AniCore anime row for ${ANIME_ID}; got ${animeRows.length}`);
  }
  const anime = animeRows[0]!;

  const anilistMappings = mappings.filter((mapping) => mapping.provider === "anilist");
  if (anilistMappings.length !== 1) {
    fail(`Expected exactly one AniList mapping for anime ${ANIME_ID}; got ${anilistMappings.length}`);
  }
  const anilistId = Number(anilistMappings[0]!.providerId);
  if (!Number.isInteger(anilistId) || anilistId <= 0) {
    fail(`Invalid AniList provider ID for anime ${ANIME_ID}: ${anilistMappings[0]!.providerId}`);
  }

  const [liveAnilist, tvdbEpisodes] = await Promise.all([
    fetchAnilistAnime(anilistId),
    getTvdbSeasonEpisodes(TVDB_SERIES_ID, TVDB_SEASON_NUMBER, "eng"),
  ]);

  const authoritativeTvdb = tvdbEpisodes
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
      title: episode.name ?? null,
      overview: episode.overview ?? null,
      airDate: episode.aired ?? null,
      seasonNumber: episode.seasonNumber ?? null,
    }))
    .sort((a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber);

  const tvdbOwnership = authoritativeTvdb.length
    ? await queryRows<EpisodeOwnerRow>(sql`
        select
          em.id as "episodeMappingId",
          em.provider_id as "providerEpisodeId",
          em.provider_episode_number as "providerEpisodeNumber",
          e.anime_id as "animeId",
          e.id as "episodeId",
          e.number as "localEpisodeNumber",
          e.kind as "localKind",
          a.title_romaji as "animeTitle",
          em.source,
          em.confidence
        from public.episode_mappings em
        join public.episodes e on e.id = em.episode_id
        join public.anime a on a.id = e.anime_id
        where em.provider = 'thetvdb'
          and em.provider_id in (${sql.join(
            authoritativeTvdb.map((episode) => sql`${episode.providerEpisodeId}`),
            sql`, `,
          )})
        order by em.id
      `)
    : [];
  const ownerByProviderId = new Map(
    tvdbOwnership.map((owner) => [owner.providerEpisodeId, owner]),
  );

  const tvdbWithOwnership = authoritativeTvdb.map((episode) => ({
    ...episode,
    owner: ownerByProviderId.get(episode.providerEpisodeId) ?? null,
  }));

  const kitsuMappings = mappings.filter((mapping) => mapping.provider === "kitsu");
  const kitsuEvidence = await Promise.all(
    kitsuMappings.map(async (mapping) => {
      const fetched = await fetchKitsuEpisodeData(mapping.providerId);
      const rows = fetched
        .map((episode) => ({
          providerEpisodeId: episode.kitsuId,
          number: episode.number,
          title: episode.title ?? null,
          titleRomaji: episode.titleRomaji ?? null,
          titleEnglish: episode.titleEnglish ?? null,
          airDate: episode.airDate ?? null,
        }))
        .sort((a, b) => a.number - b.number);
      return {
        mapping,
        episodeCount: rows.length,
        numbering: exactRange(rows.map((episode) => episode.number)),
        episodes: rows,
      };
    }),
  );

  const normalLocalEpisodes = localEpisodes.filter((episode) => episode.kind === "normal");
  const localNumbers = normalLocalEpisodes.map((episode) => episode.number);
  const liveCount = liveAnilist.episodeCount ?? null;
  const missingAgainstLiveAnilist =
    liveCount && liveCount > 0
      ? Array.from({ length: liveCount }, (_, index) => index + 1).filter(
          (number) => !localNumbers.includes(number),
        )
      : [];

  return {
    ok: true,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    operation: {
      code: "diagnose-air-episode-materialization",
      description:
        "Inspect the single local-short-metadata-exact AIR case without creating an episode. Compare stored/live AniList metadata, local episode rows, Kitsu episode materialization input, authoritative TVDB season rows, and current TVDB episode ownership.",
      animeId: ANIME_ID,
      storedAnime: anime,
      liveAnilist: {
        providerId: String(anilistId),
        titleRomaji: liveAnilist.titleRomaji,
        titleEnglish: liveAnilist.titleEnglish ?? null,
        format: liveAnilist.format ?? null,
        episodeCount: liveAnilist.episodeCount ?? null,
        startDate: liveAnilist.startDate ?? null,
        endDate: liveAnilist.endDate ?? null,
      },
      mappings,
      local: {
        normalEpisodeCount: normalLocalEpisodes.length,
        normalEpisodeNumbers: localNumbers,
        numbering: exactRange(localNumbers),
        missingAgainstLiveAnilist,
        episodes: localEpisodes,
      },
      kitsu: kitsuEvidence,
      tvdb: {
        providerId: TVDB_PROVIDER_ID,
        authoritativeEpisodeCount: authoritativeTvdb.length,
        numbering: exactRange(
          authoritativeTvdb.map((episode) => episode.providerEpisodeNumber),
        ),
        providerAssociations,
        episodes: tvdbWithOwnership,
      },
    },
  };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length > 0) {
      fail(`This diagnostic accepts no arguments; received: ${args.join(" ")}`);
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
