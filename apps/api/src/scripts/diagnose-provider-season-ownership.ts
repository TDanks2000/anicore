import { TMDB } from "@api-wrappers/tmdb-wrapper";
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
import {
  classifyProviderSeasonOwnership,
  type ProviderSeasonEpisodeOwnership,
  type ProviderSeasonOwnershipClassification,
} from "./provider-season-ownership-diagnostics";

type Provider = "thetvdb" | "tmdb";

interface ProviderEntityOwnerRow {
  providerEntityId: number;
  provider: Provider;
  providerId: string;
  ownerAnimeId: number;
}

interface EpisodeOwnerRow {
  animeId: number;
  provider: Provider;
  providerId: string;
}

interface AuthoritativeEpisode {
  providerEpisodeId: string;
  providerEpisodeNumber: number;
}

interface ClassificationSummary {
  groups: number;
  authoritativeEpisodes: number;
  orphanOwnedEpisodes: number;
  ownerOwnedEpisodes: number;
  otherAnimeOwnedEpisodes: number;
  unmappedEpisodes: number;
}

interface OwnershipSample {
  animeId: number;
  provider: Provider;
  providerId: string;
  providerEntityId: number;
  existingOwnerAnimeIds: number[];
  classification: ProviderSeasonOwnershipClassification;
  authoritativeEpisodeCount: number;
  orphanOwnedEpisodeCount: number;
  ownerOwnedEpisodeCount: number;
  otherAnimeOwnedEpisodeCount: number;
  unmappedEpisodeCount: number;
  orphanRanges: string[];
  ownerRanges: string[];
  unmappedRanges: string[];
  otherAnimeIds: number[];
}

async function queryRows<T extends Record<string, unknown>>(
  query: SQL,
): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as T[];
}

function identityKey(provider: string, providerId: string): string {
  return `${provider}\u0000${providerId}`;
}

function episodeIdentityKey(provider: string, providerEpisodeId: string): string {
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

async function loadProviderEntityOwners(): Promise<ProviderEntityOwnerRow[]> {
  return queryRows<ProviderEntityOwnerRow>(sql`
    select
      pe.id as "providerEntityId",
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

async function loadEpisodeOwners(): Promise<EpisodeOwnerRow[]> {
  return queryRows<EpisodeOwnerRow>(sql`
    select
      e.anime_id as "animeId",
      em.provider,
      em.provider_id as "providerId"
    from public.episode_mappings em
    join public.episodes e on e.id = em.episode_id
    where em.provider in ('thetvdb', 'tmdb')
    order by em.provider, em.provider_id
  `);
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

function isTvdbNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /TVDB request failed:\s*404(?:\s|:|$)/i.test(message);
}

function tvdbAuthoritativeEpisodes(
  episodes: TvdbEpisodeBase[],
): AuthoritativeEpisode[] {
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
    }))
    .sort((a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber);
}

async function resolveTvdbGroups(
  rows: CollisionEpisodeMappingRow[],
  authoritativeCache: Map<string, Promise<AuthoritativeEpisode[]>>,
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
    const cacheKey = slug.trim().toLowerCase();
    let promise = seriesCache.get(cacheKey);
    if (!promise) {
      promise = getTvdbSeriesBySlug(slug);
      seriesCache.set(cacheKey, promise);
    }
    return promise;
  };

  const getSeason = (
    seriesId: number,
    seasonNumber: number,
  ): Promise<TvdbEpisodeBase[]> => {
    const cacheKey = `${seriesId}:${seasonNumber}`;
    let promise = seasonCache.get(cacheKey);
    if (!promise) {
      promise = getTvdbSeasonEpisodes(seriesId, seasonNumber, "eng");
      seasonCache.set(cacheKey, promise);
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

      const identity = identityKey("thetvdb", verified.providerId);
      authoritativeCache.set(
        identity,
        Promise.resolve(tvdbAuthoritativeEpisodes(season)),
      );

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

function emptySummary(): ClassificationSummary {
  return {
    groups: 0,
    authoritativeEpisodes: 0,
    orphanOwnedEpisodes: 0,
    ownerOwnedEpisodes: 0,
    otherAnimeOwnedEpisodes: 0,
    unmappedEpisodes: 0,
  };
}

async function run(): Promise<Record<string, unknown>> {
  const [rows, providerOwnerRows, episodeOwnerRows] = await Promise.all([
    loadNormalOrphanRows(),
    loadProviderEntityOwners(),
    loadEpisodeOwners(),
  ]);

  if (rows.some((row) => row.provider === "thetvdb") && !process.env.TVDB_API_KEY?.trim()) {
    throw new Error("TVDB_API_KEY is required for provider season ownership diagnostics");
  }
  if (rows.some((row) => row.provider === "tmdb") && !process.env.TMDB_API_KEY?.trim()) {
    throw new Error("TMDB_API_KEY is required for provider season ownership diagnostics");
  }

  const authoritativeCache = new Map<string, Promise<AuthoritativeEpisode[]>>();
  const tmdbPlan = buildTmdbResolvedCollisionGroups(rows);
  const tvdbGroups = await resolveTvdbGroups(rows, authoritativeCache);
  const resolvedGroups = [...tmdbPlan.groups, ...tvdbGroups];

  const providerOwners = new Map<
    string,
    { providerEntityId: number; animeIds: Set<number> }
  >();
  for (const row of providerOwnerRows) {
    const identity = identityKey(row.provider, row.providerId);
    const current = providerOwners.get(identity) ?? {
      providerEntityId: row.providerEntityId,
      animeIds: new Set<number>(),
    };
    current.animeIds.add(row.ownerAnimeId);
    providerOwners.set(identity, current);
  }

  const episodeOwners = new Map<string, number>();
  for (const row of episodeOwnerRows) {
    episodeOwners.set(episodeIdentityKey(row.provider, row.providerId), row.animeId);
  }

  const tmdbKey = process.env.TMDB_API_KEY!.trim();
  const tmdb = new TMDB({ apiKey: tmdbKey });
  const getAuthoritativeSeason = (
    provider: Provider,
    providerId: string,
  ): Promise<AuthoritativeEpisode[]> => {
    const identity = identityKey(provider, providerId);
    let cached = authoritativeCache.get(identity);
    if (cached) return cached;

    const parsed = parseProviderIdentity(providerId);
    if (!parsed) {
      throw new Error(`Malformed ${provider} provider entity ID: ${providerId}`);
    }

    if (provider === "thetvdb") {
      cached = getTvdbSeasonEpisodes(parsed.entityId, parsed.seasonNumber, "eng").then(
        tvdbAuthoritativeEpisodes,
      );
    } else {
      cached = tmdb.tvSeasons
        .details(
          { tvShowID: parsed.entityId, seasonNumber: parsed.seasonNumber },
          undefined,
          { language: "en-US" },
        )
        .then((season) =>
          (season.episodes ?? [])
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
            }))
            .sort((a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber),
        );
    }
    authoritativeCache.set(identity, cached);
    return cached;
  };

  const classificationSummary = new Map<
    ProviderSeasonOwnershipClassification,
    ClassificationSummary
  >();
  const samples: OwnershipSample[] = [];
  let skippedWithoutOtherOwner = 0;

  const outcomes = await mapWithConcurrency(resolvedGroups, 5, async (group) => {
    const identity = identityKey(group.provider, group.providerId);
    const owner = providerOwners.get(identity);
    if (!owner) return null;
    const otherOwnerAnimeIds = [...owner.animeIds]
      .filter((animeId) => animeId !== group.animeId)
      .sort((a, b) => a - b);
    if (otherOwnerAnimeIds.length === 0) return null;

    const authoritative = await getAuthoritativeSeason(group.provider, group.providerId);
    const ownership: ProviderSeasonEpisodeOwnership[] = authoritative.map((episode) => ({
      ...episode,
      animeId:
        episodeOwners.get(
          episodeIdentityKey(group.provider, episode.providerEpisodeId),
        ) ?? null,
    }));
    const diagnostic = classifyProviderSeasonOwnership(
      ownership,
      group.animeId,
      otherOwnerAnimeIds,
    );

    return {
      group,
      owner,
      otherOwnerAnimeIds,
      authoritative,
      diagnostic,
    };
  });

  for (const outcome of outcomes) {
    if (!outcome) {
      skippedWithoutOtherOwner += 1;
      continue;
    }
    const { group, owner, otherOwnerAnimeIds, authoritative, diagnostic } = outcome;
    const summary = classificationSummary.get(diagnostic.classification) ?? emptySummary();
    summary.groups += 1;
    summary.authoritativeEpisodes += authoritative.length;
    summary.orphanOwnedEpisodes += diagnostic.orphanOwnedEpisodeCount;
    summary.ownerOwnedEpisodes += diagnostic.ownerOwnedEpisodeCount;
    summary.otherAnimeOwnedEpisodes += diagnostic.otherAnimeOwnedEpisodeCount;
    summary.unmappedEpisodes += diagnostic.unmappedEpisodeCount;
    classificationSummary.set(diagnostic.classification, summary);

    samples.push({
      animeId: group.animeId,
      provider: group.provider,
      providerId: group.providerId,
      providerEntityId: owner.providerEntityId,
      existingOwnerAnimeIds: otherOwnerAnimeIds,
      classification: diagnostic.classification,
      authoritativeEpisodeCount: authoritative.length,
      orphanOwnedEpisodeCount: diagnostic.orphanOwnedEpisodeCount,
      ownerOwnedEpisodeCount: diagnostic.ownerOwnedEpisodeCount,
      otherAnimeOwnedEpisodeCount: diagnostic.otherAnimeOwnedEpisodeCount,
      unmappedEpisodeCount: diagnostic.unmappedEpisodeCount,
      orphanRanges: diagnostic.orphanRanges,
      ownerRanges: diagnostic.ownerRanges,
      unmappedRanges: diagnostic.unmappedRanges,
      otherAnimeIds: diagnostic.otherAnimeIds,
    });
  }

  samples.sort(
    (a, b) =>
      a.classification.localeCompare(b.classification) ||
      b.authoritativeEpisodeCount - a.authoritativeEpisodeCount ||
      a.animeId - b.animeId,
  );

  return {
    ok: true,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    operation: {
      code: "diagnose-provider-season-ownership",
      description:
        "Compare every resolved orphan TVDB/TMDB collision against the authoritative provider season and show which AniCore anime currently owns each provider episode ID. This exposes whether the old globally-unique episode mapping table produced a clean boundary, fragmented ownership, third-anime involvement, or unmapped gaps. This command never writes data.",
      resolvedCollisionGroups: resolvedGroups.length,
      classifiedCollisionGroups: samples.length,
      skippedWithoutOtherOwner,
      byClassification: Object.fromEntries(
        [...classificationSummary.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      samples: samples.slice(0, 60),
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
