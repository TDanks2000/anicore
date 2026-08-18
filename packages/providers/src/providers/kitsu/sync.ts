import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@anicore/db";
import { animeMappings, episodes, episodeMappings } from "@anicore/db/schema";
import { fetchKitsuEpisodes } from "./client";
import {
  conflictingKitsuIdentities,
  formatKitsuIdentityConflict,
} from "./identity";
import { mapKitsuAnime, mapKitsuEpisodes, type MappedEpisode } from "./mapper";
import type { ProviderAnimeData } from "../types";
import { log } from "../../lib/logger";
import {
  findKitsuMatch,
  isAuthoritativeAnilistMatch,
  type MatchHints,
} from "./matching";

export type { MatchHints } from "./matching";

export type KitsuSyncResult =
  | { matched: true; kitsuId: string; kitsuSlug: string | null; data: ProviderAnimeData; episodeCount: number }
  | { matched: false };

export interface KitsuMappingProvenance {
  confidence: number;
  source: "api" | "fuzzy";
}

const EPISODE_CHUNK = 100;

export function kitsuMappingProvenance(
  isAuthoritative: boolean,
): KitsuMappingProvenance {
  return isAuthoritative
    ? { confidence: 100, source: "api" }
    : { confidence: 90, source: "fuzzy" };
}

export function kitsuEpisodeProviderIdsForRepair(
  mappedEpisodes: MappedEpisode[],
): string[] {
  return [...new Set(mappedEpisodes.map((episode) => episode.kitsuId))];
}

export function limitKitsuEpisodesToCanonicalCount(
  mappedEpisodes: MappedEpisode[],
  canonicalEpisodeCount?: number | null,
): MappedEpisode[] {
  if (
    canonicalEpisodeCount == null ||
    !Number.isInteger(canonicalEpisodeCount) ||
    canonicalEpisodeCount <= 0
  ) {
    return mappedEpisodes;
  }

  return mappedEpisodes.filter(
    (episode) => episode.number >= 1 && episode.number <= canonicalEpisodeCount,
  );
}

async function repairAuthoritativeKitsuMapping(
  animeId: number,
  kitsuData: ProviderAnimeData,
  isAuthoritative: boolean,
  kitsuEpisodeProviderIds: string[],
): Promise<number | null> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: animeMappings.id,
        animeId: animeMappings.animeId,
        source: animeMappings.source,
      })
      .from(animeMappings)
      .where(
        and(
          eq(animeMappings.provider, "kitsu"),
          eq(animeMappings.providerId, kitsuData.providerId),
        ),
      )
      .limit(1);
    if (!isAuthoritative || existing?.source !== "fuzzy") return null;

    const [updated] = await tx
      .update(animeMappings)
      .set({
        animeId,
        providerSlug: kitsuData.providerSlug ?? null,
        providerUrl: kitsuData.providerUrl ?? null,
        confidence: 100,
        source: "api",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(animeMappings.id, existing.id),
          eq(animeMappings.source, "fuzzy"),
        ),
      )
      .returning({ id: animeMappings.id });
    if (!updated) return null;

    if (kitsuEpisodeProviderIds.length > 0) {
      const oldEpisodeIds = tx
        .select({ id: episodes.id })
        .from(episodes)
        .where(eq(episodes.animeId, existing.animeId));

      for (let i = 0; i < kitsuEpisodeProviderIds.length; i += EPISODE_CHUNK) {
        const providerIds = kitsuEpisodeProviderIds.slice(i, i + EPISODE_CHUNK);
        await tx
          .delete(episodeMappings)
          .where(
            and(
              eq(episodeMappings.provider, "kitsu"),
              inArray(episodeMappings.providerId, providerIds),
              inArray(episodeMappings.episodeId, oldEpisodeIds),
            ),
          );
      }
    }

    return existing.animeId;
  });
}

async function insertKitsuMapping(
  animeId: number,
  kitsuData: ProviderAnimeData,
  isAuthoritative: boolean,
  kitsuEpisodeProviderIds: string[],
): Promise<void> {
  // A sync plugin is expected to resolve one Kitsu identity for an AniCore anime.
  // If matching changes from A to B, adding B beside A would make future reads
  // ambiguous and hide a potentially serious remap. Fail closed regardless of
  // provenance; an explicit repair can then decide what metadata must move.
  const existingForAnime = await db
    .select({
      providerId: animeMappings.providerId,
      source: animeMappings.source,
      confidence: animeMappings.confidence,
    })
    .from(animeMappings)
    .where(
      and(
        eq(animeMappings.animeId, animeId),
        eq(animeMappings.provider, "kitsu"),
      ),
    );

  const identityConflicts = conflictingKitsuIdentities(
    existingForAnime,
    kitsuData.providerId,
  );
  if (identityConflicts.length > 0) {
    throw new Error(
      formatKitsuIdentityConflict(kitsuData.providerId, identityConflicts),
    );
  }

  const provenance = kitsuMappingProvenance(isAuthoritative);
  const [mapping] = await db
    .insert(animeMappings)
    .values({
      animeId,
      provider: "kitsu",
      providerId: kitsuData.providerId,
      providerSlug: kitsuData.providerSlug ?? null,
      providerUrl: kitsuData.providerUrl ?? null,
      confidence: provenance.confidence,
      source: provenance.source,
      isPrimary: false,
    })
    .onConflictDoUpdate({
      target: [animeMappings.provider, animeMappings.providerId],
      set: {
        providerSlug: sql`coalesce(excluded.provider_slug, ${animeMappings.providerSlug})`,
        providerUrl: sql`coalesce(excluded.provider_url, ${animeMappings.providerUrl})`,
        confidence: sql`greatest(${animeMappings.confidence}, excluded.confidence)`,
        source: sql`case
          when ${animeMappings.source} in ('manual', 'api', 'import', 'system')
            then ${animeMappings.source}
          else excluded.source
        end`,
        isPrimary: sql`${animeMappings.isPrimary} or excluded.is_primary`,
        updatedAt: sql`now()`,
      },
      setWhere: eq(animeMappings.animeId, animeId),
    })
    .returning({ animeId: animeMappings.animeId });

  if (!mapping) {
    const repairedFromAnimeId = await repairAuthoritativeKitsuMapping(
      animeId,
      kitsuData,
      isAuthoritative,
      kitsuEpisodeProviderIds,
    );

    if (repairedFromAnimeId !== null) {
      log.warn(
        `Reassigned stale fuzzy Kitsu mapping ${kitsuData.providerId} from anime ${repairedFromAnimeId} to ${animeId} using Kitsu's AniList mapping`,
      );
      return;
    }

    throw new Error(
      `Kitsu mapping ${kitsuData.providerId} already belongs to another anime`,
    );
  }
}

export async function syncKitsuFromAnilist(
  anilistId: string,
  hints: MatchHints,
): Promise<KitsuSyncResult> {
  const [existingAnilist] = await db
    .select({ animeId: animeMappings.animeId })
    .from(animeMappings)
    .where(
      and(
        eq(animeMappings.provider, "anilist"),
        eq(animeMappings.providerId, anilistId),
      ),
    )
    .limit(1);

  if (!existingAnilist) {
    throw new Error(
      `AniList ID ${anilistId} not found in DB — sync AniList first`,
    );
  }

  const kitsuNode = await findKitsuMatch(hints);
  if (!kitsuNode) return { matched: false };

  const isAuthoritative = isAuthoritativeAnilistMatch(kitsuNode, anilistId);
  const provenance = kitsuMappingProvenance(isAuthoritative);

  const allMappedEpisodes = await fetchKitsuEpisodeData(kitsuNode.id);
  const kitsuEpisodeProviderIds = kitsuEpisodeProviderIdsForRepair(allMappedEpisodes);
  const mappedEpisodes = limitKitsuEpisodesToCanonicalCount(
    allMappedEpisodes,
    hints.episodeCount,
  );

  const kitsuData = mapKitsuAnime(kitsuNode);
  await insertKitsuMapping(
    existingAnilist.animeId,
    kitsuData,
    isAuthoritative,
    kitsuEpisodeProviderIds,
  );

  const episodeCount = await syncKitsuEpisodes(
    existingAnilist.animeId,
    kitsuNode.id,
    mappedEpisodes,
    provenance,
  );

  return {
    matched: true,
    kitsuId: kitsuNode.id,
    kitsuSlug: kitsuNode.slug,
    data: kitsuData,
    episodeCount,
  };
}

export async function fetchKitsuEpisodeData(
  kitsuId: string,
): Promise<MappedEpisode[]> {
  const nodes = await fetchKitsuEpisodes(kitsuId);
  return mapKitsuEpisodes(nodes);
}

export async function syncKitsuEpisodes(
  animeId: number,
  kitsuAnimeId: string,
  prefetchedEpisodes?: MappedEpisode[],
  provenance: KitsuMappingProvenance = { confidence: 100, source: "api" },
): Promise<number> {
  const mapped = prefetchedEpisodes ?? await fetchKitsuEpisodeData(kitsuAnimeId);
  if (!mapped.length) return 0;

  const idByNumber = new Map<number, number>();

  for (let i = 0; i < mapped.length; i += EPISODE_CHUNK) {
    const chunk = mapped.slice(i, i + EPISODE_CHUNK);
    const rows = chunk.map((ep) => ({
      animeId,
      number:        ep.number,
      sortNumber:    ep.number,
      title:         ep.title,
      titleRomaji:   ep.titleRomaji,
      titleEnglish:  ep.titleEnglish,
      synopsis:      ep.description,
      airDate:       ep.airDate,
      thumbnail:     ep.thumbnail,
      lengthMinutes: ep.lengthMinutes,
      kind:          "normal" as const,
    }));

    const inserted = await db
      .insert(episodes)
      .values(rows)
      .onConflictDoUpdate({
        target: [episodes.animeId, episodes.number, episodes.kind],
        set: {
          title:         sql`coalesce(episodes.title, excluded.title)`,
          titleRomaji:   sql`coalesce(episodes.title_romaji, excluded.title_romaji)`,
          titleEnglish:  sql`coalesce(episodes.title_english, excluded.title_english)`,
          synopsis:      sql`coalesce(episodes.synopsis, excluded.synopsis)`,
          airDate:       sql`coalesce(episodes.air_date, excluded.air_date)`,
          thumbnail:     sql`coalesce(episodes.thumbnail, excluded.thumbnail)`,
          lengthMinutes: sql`coalesce(episodes.length_minutes, excluded.length_minutes)`,
          updatedAt:     sql`now()`,
        },
      })
      .returning({ id: episodes.id, number: episodes.number });

    for (const row of inserted) {
      idByNumber.set(row.number, row.id);
    }
  }

  const mappingRows = mapped
    .map((ep) => {
      const episodeId = idByNumber.get(ep.number);
      if (!episodeId) return null;
      return {
        episodeId,
        provider:              "kitsu" as const,
        providerId:            ep.kitsuId,
        providerSlug:          null,
        providerUrl:           null,
        providerEpisodeNumber: String(ep.number),
        confidence:            provenance.confidence,
        source:                provenance.source,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  for (let i = 0; i < mappingRows.length; i += EPISODE_CHUNK) {
    const batch = mappingRows.slice(i, i + EPISODE_CHUNK);
    const written = await db
      .insert(episodeMappings)
      .values(batch)
      .onConflictDoUpdate({
        target: [episodeMappings.provider, episodeMappings.providerId],
        set: {
          providerSlug: sql`coalesce(excluded.provider_slug, ${episodeMappings.providerSlug})`,
          providerUrl: sql`coalesce(excluded.provider_url, ${episodeMappings.providerUrl})`,
          providerEpisodeNumber: sql`excluded.provider_episode_number`,
          confidence: sql`case
            when ${episodeMappings.source} in ('manual', 'import', 'system')
              then greatest(${episodeMappings.confidence}, excluded.confidence)
            else excluded.confidence
          end`,
          source: sql`case
            when ${episodeMappings.source} in ('manual', 'import', 'system')
              then ${episodeMappings.source}
            else excluded.source
          end`,
          updatedAt: sql`now()`,
        },
        setWhere: sql`${episodeMappings.episodeId} = excluded.episode_id`,
      })
      .returning({ id: episodeMappings.id });

    if (written.length !== batch.length) {
      throw new Error(
        "One or more Kitsu episode mappings belong to another episode",
      );
    }
  }

  return mapped.length;
}
