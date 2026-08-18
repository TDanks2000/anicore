import { sql, type SQL } from "drizzle-orm";

import { closeDb, db } from "@anicore/db";
import {
  getTvdbSeasonEpisodes,
  getTvdbSeriesBySlug,
  type TvdbEpisodeBase,
  type TvdbSeriesBaseRecord,
} from "@anicore/providers/thetvdb/client";

import {
  buildTvdbSlugResolutionGroups,
  verifyResolvedTvdbSlugGroup,
  type TvdbSlugResolutionGroup,
} from "./orphan-tvdb-slug-repair";
import {
  buildTmdbResolvedCollisionGroups,
  type CollisionEpisodeMappingRow,
  type ResolvedCollisionGroup,
} from "./provider-collision-segment-plan";

type Provider = "thetvdb" | "tmdb";

type IdentityEvidence =
  | "direct-prequel-sequel"
  | "direct-related-other"
  | "not-directly-related"
  | "missing-anime-metadata";

interface ProviderEntityOwnerRow {
  provider: Provider;
  providerId: string;
  ownerAnimeId: number;
}

interface AnimeMetadataRow {
  animeId: number;
  titleRomaji: string;
  titleEnglish: string | null;
  format: string | null;
  season: string | null;
  seasonYear: number | null;
  startDate: string | null;
  endDate: string | null;
  episodeCount: number | null;
}

interface RelationRow {
  animeId: number;
  relatedAnimeId: number;
  relationType: string;
}

interface AniListMappingRow {
  animeId: number;
  providerId: string;
}

interface IdentitySample {
  provider: Provider;
  providerId: string;
  orphanAnimeId: number;
  ownerAnimeId: number;
  evidence: IdentityEvidence;
  relationTypes: string[];
  orphanAniListId: string | null;
  ownerAniListId: string | null;
  orphan: AnimeMetadataRow | null;
  owner: AnimeMetadataRow | null;
  orphanMappedLocalRange: string | null;
  orphanMappedEpisodeCount: number;
  orphanMappedStartsAtOne: boolean;
}

async function queryRows<T extends Record<string, unknown>>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as T[];
}

function identityKey(provider: string, providerId: string): string {
  return `${provider}\u0000${providerId}`;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function formatRange(numbers: number[]): string | null {
  const sorted = [...new Set(numbers)]
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[0] === sorted[sorted.length - 1]
    ? String(sorted[0])
    : `${sorted[0]}-${sorted[sorted.length - 1]}`;
}

async function loadNormalOrphanRows(): Promise<CollisionEpisodeMappingRow[]> {
  return queryRows<CollisionEpisodeMappingRow>(sql`
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
      em.confidence,
      e.number as "localEpisodeNumber",
      (
        select count(*)::int
        from public.episodes local_episode
        where local_episode.anime_id = e.anime_id
          and local_episode.kind = 'normal'
      ) as "localNormalEpisodeCount"
    from public.episode_mappings em
    join public.episodes e on e.id = em.episode_id
    where em.provider in ('thetvdb', 'tmdb')
      and e.kind = 'normal'
      and not exists (
        select 1
        from public.anime_mappings am
        where am.anime_id = e.anime_id
          and am.provider = em.provider
      )
    order by e.anime_id, em.provider, e.number, em.id
  `);
}

async function loadProviderOwners(): Promise<ProviderEntityOwnerRow[]> {
  return queryRows<ProviderEntityOwnerRow>(sql`
    select
      pe.provider,
      pe.provider_id as "providerId",
      apm.anime_id as "ownerAnimeId"
    from public.provider_entities pe
    join public.anime_provider_mappings apm
      on apm.provider_entity_id = pe.id
    where pe.provider in ('thetvdb', 'tmdb')
    order by pe.provider, pe.provider_id, apm.anime_id
  `);
}

async function loadAnimeMetadata(): Promise<AnimeMetadataRow[]> {
  return queryRows<AnimeMetadataRow>(sql`
    select
      id as "animeId",
      title_romaji as "titleRomaji",
      title_english as "titleEnglish",
      format,
      season,
      season_year as "seasonYear",
      start_date as "startDate",
      end_date as "endDate",
      episode_count as "episodeCount"
    from public.anime
  `);
}

async function loadRelations(): Promise<RelationRow[]> {
  return queryRows<RelationRow>(sql`
    select
      anime_id as "animeId",
      related_anime_id as "relatedAnimeId",
      relation_type as "relationType"
    from public.anime_relation_links
  `);
}

async function loadAniListMappings(): Promise<AniListMappingRow[]> {
  return queryRows<AniListMappingRow>(sql`
    select anime_id as "animeId", provider_id as "providerId"
    from public.anime_mappings
    where provider = 'anilist'
  `);
}

function isTvdbNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /TVDB request failed:\s*404(?:\s|:|$)/i.test(message);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

async function resolveTvdbGroups(
  rows: CollisionEpisodeMappingRow[],
): Promise<ResolvedCollisionGroup[]> {
  const groupPlan = buildTvdbSlugResolutionGroups(rows);
  const rowsByAnime = new Map<number, CollisionEpisodeMappingRow[]>();
  for (const row of rows) {
    if (row.provider !== "thetvdb") continue;
    const group = rowsByAnime.get(row.animeId) ?? [];
    group.push(row);
    rowsByAnime.set(row.animeId, group);
  }

  const seriesCache = new Map<string, Promise<TvdbSeriesBaseRecord | null>>();
  const seasonCache = new Map<string, Promise<TvdbEpisodeBase[]>>();

  const getSeries = (slug: string): Promise<TvdbSeriesBaseRecord | null> => {
    const key = slug.trim().toLowerCase();
    let promise = seriesCache.get(key);
    if (!promise) {
      promise = getTvdbSeriesBySlug(slug);
      seriesCache.set(key, promise);
    }
    return promise;
  };

  const getSeason = (seriesId: number, seasonNumber: number): Promise<TvdbEpisodeBase[]> => {
    const key = `${seriesId}:${seasonNumber}`;
    let promise = seasonCache.get(key);
    if (!promise) {
      promise = getTvdbSeasonEpisodes(seriesId, seasonNumber, "eng");
      seasonCache.set(key, promise);
    }
    return promise;
  };

  const outcomes = await mapWithConcurrency(
    groupPlan.groups,
    4,
    async (group: TvdbSlugResolutionGroup): Promise<ResolvedCollisionGroup | null> => {
      let series: TvdbSeriesBaseRecord | null;
      try {
        series = await getSeries(group.slug);
      } catch (error) {
        if (isTvdbNotFoundError(error)) return null;
        throw error;
      }
      if (!series) return null;
      const season = await getSeason(series.id, group.seasonNumber);
      const verified = verifyResolvedTvdbSlugGroup(group, series, season);
      if (!verified) return null;
      return {
        animeId: verified.animeId,
        provider: "thetvdb",
        providerId: verified.providerId,
        providerSlug: verified.providerSlug,
        providerUrl: verified.providerUrl,
        confidence: verified.confidence,
        rows: rowsByAnime.get(verified.animeId) ?? [],
      };
    },
  );

  return outcomes.filter((group): group is ResolvedCollisionGroup => Boolean(group));
}

function classifyEvidence(
  orphan: AnimeMetadataRow | undefined,
  owner: AnimeMetadataRow | undefined,
  relationTypes: string[],
): IdentityEvidence {
  if (!orphan || !owner) return "missing-anime-metadata";
  const normalized = relationTypes.map((value) => value.trim().toUpperCase());
  if (normalized.some((value) => value === "PREQUEL" || value === "SEQUEL")) {
    return "direct-prequel-sequel";
  }
  if (normalized.length > 0) return "direct-related-other";
  return "not-directly-related";
}

async function run(): Promise<Record<string, unknown>> {
  const [orphanRows, providerOwners, animeRows, relationRows, anilistRows] =
    await Promise.all([
      loadNormalOrphanRows(),
      loadProviderOwners(),
      loadAnimeMetadata(),
      loadRelations(),
      loadAniListMappings(),
    ]);

  if (orphanRows.some((row) => row.provider === "thetvdb") && !process.env.TVDB_API_KEY?.trim()) {
    throw new Error("TVDB_API_KEY is required for provider collision identity diagnostics");
  }

  const tmdbPlan = buildTmdbResolvedCollisionGroups(orphanRows);
  const tvdbGroups = await resolveTvdbGroups(orphanRows);
  const resolvedGroups = [...tmdbPlan.groups, ...tvdbGroups];

  const ownersByIdentity = new Map<string, number[]>();
  for (const row of providerOwners) {
    const key = identityKey(row.provider, row.providerId);
    const list = ownersByIdentity.get(key) ?? [];
    list.push(row.ownerAnimeId);
    ownersByIdentity.set(key, list);
  }

  const animeById = new Map(animeRows.map((row) => [row.animeId, row]));
  const anilistByAnimeId = new Map(anilistRows.map((row) => [row.animeId, row.providerId]));
  const relationTypesByPair = new Map<string, Set<string>>();
  for (const row of relationRows) {
    const key = pairKey(row.animeId, row.relatedAnimeId);
    const set = relationTypesByPair.get(key) ?? new Set<string>();
    set.add(row.relationType);
    relationTypesByPair.set(key, set);
  }

  const samples: IdentitySample[] = [];
  const evidenceCounts = new Map<IdentityEvidence, number>();
  const relationTypeCounts = new Map<string, number>();
  let singleOwnerGroups = 0;
  let multiOwnerGroups = 0;
  let missingOwnerGroups = 0;

  for (const group of resolvedGroups) {
    const owners = (ownersByIdentity.get(identityKey(group.provider, group.providerId)) ?? [])
      .filter((animeId) => animeId !== group.animeId)
      .sort((a, b) => a - b);
    if (owners.length === 0) {
      missingOwnerGroups += 1;
      continue;
    }
    if (owners.length !== 1) {
      multiOwnerGroups += 1;
      continue;
    }
    singleOwnerGroups += 1;
    const ownerAnimeId = owners[0]!;
    const relationTypes = [...(relationTypesByPair.get(pairKey(group.animeId, ownerAnimeId)) ?? [])]
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean)
      .sort();
    const evidence = classifyEvidence(
      animeById.get(group.animeId),
      animeById.get(ownerAnimeId),
      relationTypes,
    );
    evidenceCounts.set(evidence, (evidenceCounts.get(evidence) ?? 0) + 1);
    for (const relationType of relationTypes) {
      relationTypeCounts.set(relationType, (relationTypeCounts.get(relationType) ?? 0) + 1);
    }

    const mappedNumbers = group.rows.map((row) => row.localEpisodeNumber);
    samples.push({
      provider: group.provider,
      providerId: group.providerId,
      orphanAnimeId: group.animeId,
      ownerAnimeId,
      evidence,
      relationTypes,
      orphanAniListId: anilistByAnimeId.get(group.animeId) ?? null,
      ownerAniListId: anilistByAnimeId.get(ownerAnimeId) ?? null,
      orphan: animeById.get(group.animeId) ?? null,
      owner: animeById.get(ownerAnimeId) ?? null,
      orphanMappedLocalRange: formatRange(mappedNumbers),
      orphanMappedEpisodeCount: mappedNumbers.length,
      orphanMappedStartsAtOne: mappedNumbers.includes(1),
    });
  }

  samples.sort(
    (a, b) =>
      a.evidence.localeCompare(b.evidence) ||
      a.provider.localeCompare(b.provider) ||
      a.providerId.localeCompare(b.providerId) ||
      a.orphanAnimeId - b.orphanAnimeId,
  );

  const byProvider = Object.fromEntries(
    (["thetvdb", "tmdb"] as Provider[]).map((provider) => {
      const providerSamples = samples.filter((sample) => sample.provider === provider);
      return [
        provider,
        {
          groups: providerSamples.length,
          directPrequelSequel: providerSamples.filter(
            (sample) => sample.evidence === "direct-prequel-sequel",
          ).length,
          directRelatedOther: providerSamples.filter(
            (sample) => sample.evidence === "direct-related-other",
          ).length,
          notDirectlyRelated: providerSamples.filter(
            (sample) => sample.evidence === "not-directly-related",
          ).length,
        },
      ];
    }),
  );

  return {
    ok: true,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    operation: {
      code: "diagnose-provider-collision-identities",
      description:
        "Compare resolved orphan TVDB/TMDB provider-season collisions against AniCore/AniList anime identity evidence. This reports direct AniList relation links, titles, formats, dates, episode counts, and AniList IDs before any segment migration is allowed. This command never writes data.",
      resolvedCollisionGroups: resolvedGroups.length,
      singleOwnerGroups,
      multiOwnerGroups,
      missingOwnerGroups,
      byIdentityEvidence: Object.fromEntries(
        [...evidenceCounts.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      byRelationType: Object.fromEntries(
        [...relationTypeCounts.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      byProvider,
      samples: samples.slice(0, 80),
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
