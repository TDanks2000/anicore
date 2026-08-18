import { TMDB } from "@api-wrappers/tmdb-wrapper";
import { sql, type SQL } from "drizzle-orm";

import { closeDb, db } from "@anicore/db";
import {
  getTvdbSeasonEpisodes,
  getTvdbSeriesBySlug,
  getTvdbSeriesExtended,
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
  earliestProviderAirDate,
  verifyProviderSeasonAirdate,
  type ProviderSeasonAirdateRejectReason,
  type ProviderSeasonAirdateResult,
} from "./provider-season-airdate-verification";
import {
  verifyProviderSeasonIdentity,
  type ProviderSeasonIdentityRejectReason,
  type ProviderSeasonIdentityResult,
} from "./provider-season-identity-verification";
import {
  planWholeSeasonOwnershipRepair,
  type WholeSeasonAuthoritativeEpisode,
  type WholeSeasonMappedEpisode,
  type WholeSeasonRepairRejectReason,
} from "./whole-season-ownership-repair-plan";

type Provider = "thetvdb" | "tmdb";

type DiagnosticRejectReason =
  | WholeSeasonRepairRejectReason
  | ProviderSeasonIdentityRejectReason
  | ProviderSeasonAirdateRejectReason
  | "missing-provider-entity"
  | "owner-count-not-one"
  | "target-association-already-exists"
  | "missing-target-metadata";

interface ProviderEntityMappingRow {
  providerEntityId: number;
  provider: Provider;
  providerId: string;
  animeId: number;
  confidence: number;
  source: string;
}

interface EpisodeMappingRow {
  animeId: number;
  provider: Provider;
  providerEpisodeId: string;
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
  titleEnglish: string | null;
  titleNative: string | null;
  titleUserPreferred: string | null;
  synonymsJson: string;
  format: string | null;
  episodeCount: number | null;
  startDate: string | null;
}

interface SeasonEvidence {
  episodes: WholeSeasonAuthoritativeEpisode[];
  firstAirDate: string | null;
}

interface DiagnosticOutcome {
  group: ResolvedCollisionGroup;
  owner: ProviderEntityMappingRow | null;
  plan: ReturnType<typeof planWholeSeasonOwnershipRepair> | null;
  structurallySafe: boolean;
  identity: ProviderSeasonIdentityResult | null;
  airdate: ProviderSeasonAirdateResult | null;
  reason: DiagnosticRejectReason | null;
}

interface CandidateSample {
  provider: Provider;
  providerId: string;
  providerEntityId: number;
  targetAnimeId: number;
  targetTitle: string;
  targetFormat: string | null;
  targetMetadataEpisodeCount: number | null;
  targetStartDate: string | null;
  currentOwnerAnimeId: number;
  currentOwnerTitle: string | null;
  currentOwnerFormat: string | null;
  currentOwnerMetadataEpisodeCount: number | null;
  currentOwnerStartDate: string | null;
  currentOwnerMappingSource: string;
  currentOwnerMappingConfidence: number;
  authoritativeEpisodeCount: number;
  targetOwnedEpisodeCount: number;
  ownerOwnedEpisodeCount: number;
  providerEpisodeNumbersToMove: number[];
  providerTitles: string[];
  bestProviderTitle: string | null;
  bestTargetTitle: string | null;
  bestTitleSimilarity: number;
  providerFirstAirDate: string | null;
  startDateDeltaDays: number | null;
}

interface RejectedSample {
  animeId: number;
  provider: Provider;
  providerId: string;
  reason: DiagnosticRejectReason;
  targetTitle: string | null;
  targetStartDate: string | null;
  providerFirstAirDate: string | null;
  startDateDeltaDays: number | null;
}

async function queryRows<T extends Record<string, unknown>>(query: SQL): Promise<T[]> {
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

async function loadProviderEntityMappings(): Promise<ProviderEntityMappingRow[]> {
  return queryRows<ProviderEntityMappingRow>(sql`
    select
      pe.id as "providerEntityId",
      pe.provider,
      pe.provider_id as "providerId",
      apm.anime_id as "animeId",
      apm.confidence,
      apm.source
    from public.provider_entities pe
    join public.anime_provider_mappings apm
      on apm.provider_entity_id = pe.id
    where pe.provider in ('thetvdb', 'tmdb')
    order by pe.provider, pe.provider_id, apm.anime_id
  `);
}

async function loadEpisodeMappings(): Promise<EpisodeMappingRow[]> {
  return queryRows<EpisodeMappingRow>(sql`
    select
      e.anime_id as "animeId",
      em.provider,
      em.provider_id as "providerEpisodeId",
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
      title_english as "titleEnglish",
      title_native as "titleNative",
      title_user_preferred as "titleUserPreferred",
      synonyms_json as "synonymsJson",
      format,
      episode_count as "episodeCount",
      start_date as "startDate"
    from public.anime
    order by id
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

function tvdbSeasonEvidence(episodes: TvdbEpisodeBase[]): SeasonEvidence {
  const authoritative = episodes
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

  return {
    episodes: authoritative,
    firstAirDate: earliestProviderAirDate(episodes.map((episode) => episode.aired)),
  };
}

async function resolveTvdbGroups(
  rows: CollisionEpisodeMappingRow[],
  evidenceCache: Map<string, Promise<SeasonEvidence>>,
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
      evidenceCache.set(
        identityKey("thetvdb", verified.providerId),
        Promise.resolve(tvdbSeasonEvidence(season)),
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

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

async function run(): Promise<Record<string, unknown>> {
  const [orphanRows, entityMappings, episodeRows, localNormalRows, animeMetaRows] =
    await Promise.all([
      loadNormalOrphanRows(),
      loadProviderEntityMappings(),
      loadEpisodeMappings(),
      loadLocalNormalEpisodes(),
      loadAnimeMeta(),
    ]);

  if (orphanRows.some((row) => row.provider === "thetvdb") && !process.env.TVDB_API_KEY?.trim()) {
    throw new Error("TVDB_API_KEY is required for provider season airdate diagnosis");
  }
  if (orphanRows.some((row) => row.provider === "tmdb") && !process.env.TMDB_API_KEY?.trim()) {
    throw new Error("TMDB_API_KEY is required for provider season airdate diagnosis");
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

  const evidenceCache = new Map<string, Promise<SeasonEvidence>>();
  const tmdbPlan = buildTmdbResolvedCollisionGroups(orphanRows);
  const tvdbGroups = await resolveTvdbGroups(orphanRows, evidenceCache);
  const resolvedGroups = [...tmdbPlan.groups, ...tvdbGroups];

  const mappingsByEntity = new Map<string, ProviderEntityMappingRow[]>();
  for (const row of entityMappings) {
    const key = identityKey(row.provider, row.providerId);
    const list = mappingsByEntity.get(key) ?? [];
    list.push(row);
    mappingsByEntity.set(key, list);
  }

  const episodeMap = new Map<string, EpisodeMappingRow>();
  for (const row of episodeRows) {
    episodeMap.set(episodeIdentityKey(row.provider, row.providerEpisodeId), row);
  }

  const localNormalsByAnime = new Map<number, number[]>();
  for (const row of localNormalRows) {
    const list = localNormalsByAnime.get(row.animeId) ?? [];
    list.push(row.episodeNumber);
    localNormalsByAnime.set(row.animeId, list);
  }
  const metaByAnime = new Map(animeMetaRows.map((row) => [row.animeId, row]));

  const getSeasonEvidence = (provider: Provider, providerId: string): Promise<SeasonEvidence> => {
    const key = identityKey(provider, providerId);
    const cached = evidenceCache.get(key);
    if (cached) return cached;
    const parsed = parseProviderIdentity(providerId);
    if (!parsed) throw new Error(`Malformed ${provider} provider ID: ${providerId}`);

    const promise =
      provider === "thetvdb"
        ? getTvdbSeasonEpisodes(parsed.entityId, parsed.seasonNumber, "eng").then(
            tvdbSeasonEvidence,
          )
        : getTmdb()
            .tvSeasons.details(
              { tvShowID: parsed.entityId, seasonNumber: parsed.seasonNumber },
              undefined,
              { language: "en-US" },
            )
            .then((season) => ({
              episodes: (season.episodes ?? [])
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
              firstAirDate: earliestProviderAirDate([
                season.air_date,
                ...(season.episodes ?? []).map((episode) => episode.air_date),
              ]),
            }));
    evidenceCache.set(key, promise);
    return promise;
  };

  const providerTitlesCache = new Map<string, Promise<string[]>>();
  const getProviderTitles = (provider: Provider, providerId: string): Promise<string[]> => {
    const key = identityKey(provider, providerId);
    const cached = providerTitlesCache.get(key);
    if (cached) return cached;
    const parsed = parseProviderIdentity(providerId);
    if (!parsed) throw new Error(`Malformed ${provider} provider ID: ${providerId}`);

    const promise =
      provider === "thetvdb"
        ? getTvdbSeriesExtended(parsed.entityId).then((series) =>
            series?.name ? [series.name] : [],
          )
        : getTmdb()
            .tvShows.details(parsed.entityId, undefined, "en-US")
            .then((show) =>
              [show.name, show.original_name].filter(
                (title): title is string => typeof title === "string" && title.trim().length > 0,
              ),
            );
    providerTitlesCache.set(key, promise);
    return promise;
  };

  const outcomes = await mapWithConcurrency<ResolvedCollisionGroup, DiagnosticOutcome>(
    resolvedGroups,
    5,
    async (group) => {
      const mappings = mappingsByEntity.get(identityKey(group.provider, group.providerId));
      if (!mappings || mappings.length === 0) {
        return {
          group,
          owner: null,
          plan: null,
          structurallySafe: false,
          identity: null,
          airdate: null,
          reason: "missing-provider-entity",
        };
      }
      if (mappings.some((mapping) => mapping.animeId === group.animeId)) {
        return {
          group,
          owner: null,
          plan: null,
          structurallySafe: false,
          identity: null,
          airdate: null,
          reason: "target-association-already-exists",
        };
      }
      const owners = mappings.filter((mapping) => mapping.animeId !== group.animeId);
      if (owners.length !== 1) {
        return {
          group,
          owner: null,
          plan: null,
          structurallySafe: false,
          identity: null,
          airdate: null,
          reason: "owner-count-not-one",
        };
      }

      const owner = owners[0]!;
      const evidence = await getSeasonEvidence(group.provider, group.providerId);
      const mappedEpisodes: WholeSeasonMappedEpisode[] = [];
      for (const episode of evidence.episodes) {
        const mapping = episodeMap.get(
          episodeIdentityKey(group.provider, episode.providerEpisodeId),
        );
        if (!mapping) continue;
        mappedEpisodes.push({
          providerEpisodeId: episode.providerEpisodeId,
          animeId: mapping.animeId,
          localEpisodeNumber: mapping.localEpisodeNumber,
          localKind: mapping.localKind,
        });
      }

      const plan = planWholeSeasonOwnershipRepair({
        targetAnimeId: group.animeId,
        currentOwnerAnimeId: owner.animeId,
        authoritativeEpisodes: evidence.episodes,
        mappedEpisodes,
        targetNormalEpisodeNumbers: localNormalsByAnime.get(group.animeId) ?? [],
        ownerNormalEpisodeCount: (localNormalsByAnime.get(owner.animeId) ?? []).length,
      });
      if (!plan.candidate) {
        return {
          group,
          owner,
          plan,
          structurallySafe: false,
          identity: null,
          airdate: null,
          reason: plan.reason,
        };
      }

      const targetMeta = metaByAnime.get(group.animeId);
      if (!targetMeta) {
        return {
          group,
          owner,
          plan,
          structurallySafe: true,
          identity: null,
          airdate: null,
          reason: "missing-target-metadata",
        };
      }

      const providerTitles = await getProviderTitles(group.provider, group.providerId);
      const identity = verifyProviderSeasonIdentity({
        anime: targetMeta,
        authoritativeEpisodeCount: plan.candidate.authoritativeEpisodeCount,
        providerTitles,
      });
      if (!identity.ok) {
        return {
          group,
          owner,
          plan,
          structurallySafe: true,
          identity,
          airdate: null,
          reason: identity.reason,
        };
      }

      const airdate = verifyProviderSeasonAirdate({
        targetStartDate: targetMeta.startDate,
        providerFirstAirDate: evidence.firstAirDate,
      });
      return {
        group,
        owner,
        plan,
        structurallySafe: true,
        identity,
        airdate,
        reason: airdate.reason,
      };
    },
  );

  let structurallySafeGroups = 0;
  let identityVerifiedGroups = 0;
  let airdateVerifiedGroups = 0;
  let plannedEpisodeMappingReassignments = 0;
  const rejectionCounts = new Map<string, number>();
  const candidateSamples: CandidateSample[] = [];
  const rejectedSamples: RejectedSample[] = [];
  const byProvider = new Map<Provider, { groups: number; episodeMoves: number }>([
    ["thetvdb", { groups: 0, episodeMoves: 0 }],
    ["tmdb", { groups: 0, episodeMoves: 0 }],
  ]);

  for (const outcome of outcomes) {
    const { group, owner, plan, structurallySafe, identity, airdate, reason } = outcome;
    if (structurallySafe) structurallySafeGroups += 1;
    if (structurallySafe && identity?.ok) identityVerifiedGroups += 1;

    const targetMeta = metaByAnime.get(group.animeId);
    if (!plan?.candidate || !owner || reason) {
      const rejectReason = reason ?? "owner-count-not-one";
      increment(rejectionCounts, rejectReason);
      if (rejectedSamples.length < 80) {
        rejectedSamples.push({
          animeId: group.animeId,
          provider: group.provider,
          providerId: group.providerId,
          reason: rejectReason,
          targetTitle: targetMeta?.titleRomaji ?? null,
          targetStartDate: targetMeta?.startDate ?? null,
          providerFirstAirDate: airdate?.providerFirstAirDate ?? null,
          startDateDeltaDays: airdate?.startDateDeltaDays ?? null,
        });
      }
      continue;
    }

    airdateVerifiedGroups += 1;
    plannedEpisodeMappingReassignments += plan.candidate.ownerOwnedEpisodeCount;
    const providerSummary = byProvider.get(group.provider)!;
    providerSummary.groups += 1;
    providerSummary.episodeMoves += plan.candidate.ownerOwnedEpisodeCount;

    if (candidateSamples.length < 80) {
      const ownerMeta = metaByAnime.get(owner.animeId);
      candidateSamples.push({
        provider: group.provider,
        providerId: group.providerId,
        providerEntityId: owner.providerEntityId,
        targetAnimeId: group.animeId,
        targetTitle: targetMeta!.titleRomaji,
        targetFormat: targetMeta!.format,
        targetMetadataEpisodeCount: targetMeta!.episodeCount,
        targetStartDate: targetMeta!.startDate,
        currentOwnerAnimeId: owner.animeId,
        currentOwnerTitle: ownerMeta?.titleRomaji ?? null,
        currentOwnerFormat: ownerMeta?.format ?? null,
        currentOwnerMetadataEpisodeCount: ownerMeta?.episodeCount ?? null,
        currentOwnerStartDate: ownerMeta?.startDate ?? null,
        currentOwnerMappingSource: owner.source,
        currentOwnerMappingConfidence: owner.confidence,
        authoritativeEpisodeCount: plan.candidate.authoritativeEpisodeCount,
        targetOwnedEpisodeCount: plan.candidate.targetOwnedEpisodeCount,
        ownerOwnedEpisodeCount: plan.candidate.ownerOwnedEpisodeCount,
        providerEpisodeNumbersToMove: plan.candidate.providerEpisodeNumbersToMove,
        providerTitles: identity!.providerTitles,
        bestProviderTitle: identity!.bestProviderTitle,
        bestTargetTitle: identity!.bestTargetTitle,
        bestTitleSimilarity: identity!.bestTitleSimilarity,
        providerFirstAirDate: airdate!.providerFirstAirDate,
        startDateDeltaDays: airdate!.startDateDeltaDays,
      });
    }
  }

  candidateSamples.sort(
    (a, b) =>
      (b.startDateDeltaDays ?? 0) - (a.startDateDeltaDays ?? 0) ||
      b.authoritativeEpisodeCount - a.authoritativeEpisodeCount ||
      a.targetAnimeId - b.targetAnimeId,
  );
  rejectedSamples.sort(
    (a, b) =>
      a.reason.localeCompare(b.reason) ||
      a.provider.localeCompare(b.provider) ||
      a.animeId - b.animeId,
  );

  return {
    ok: true,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    operation: {
      code: "diagnose-provider-season-airdates",
      description:
        "Re-run the strict whole-season ownership candidate proof and require the authoritative TVDB/TMDB season first airdate to fall within 180 days of AniList's target start date. This independent date gate is intended to reject same-title remakes or installments before any ownership repair becomes write-capable. This command never writes data.",
      resolvedCollisionGroups: resolvedGroups.length,
      structurallySafeGroups,
      identityVerifiedGroups,
      airdateVerifiedGroups,
      plannedEpisodeMappingReassignments,
      byProvider: Object.fromEntries(byProvider.entries()),
      rejectedByReason: Object.fromEntries(
        [...rejectionCounts.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
      candidateSamples,
      rejectedSamples,
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
