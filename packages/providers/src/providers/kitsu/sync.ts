import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@anicore/db";
import { animeMappings, episodes, episodeMappings } from "@anicore/db/schema";
import { fetchKitsuEpisodes } from "./client";
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

async function repairAuthoritativeKitsuMapping(
  animeId: number,
  kitsuData: ProviderAnimeData,
  isAuthoritative: boolean,
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

    const oldEpisodeIds = tx
      .select({ id: episodes.id })
      .from(episodes)
      .where(eq(episodes.animeId, existing.animeId));
    await tx
      .delete(episodeMappings)
      .where(
        and(
          eq(episodeMappings.provider, "kitsu"),
          inArray(episodeMappings.episodeId, oldEpisodeIds),
        ),
      );

    return existing.animeId;
  });
}

async function insertKitsuMapping(
  animeId: number,
  kitsuData: ProviderAnimeData,
  isAuthoritative: boolean,
): Promise<void> {
  const [mapping] = await db
    .insert(animeMappings)
    .values({
      animeId,
      provider: "kitsu",
      providerId: kitsuData.providerId,
      providerSlug: kitsuData.providerSlug ?? null,
      providerUrl: kitsuData.providerUrl ?? null,
      confidence: isAuthoritative ? 100 : 90,
      source: isAuthoritative ? "api" : "fuzzy",
      isPrimary: false,
    })
    .onConflictDoUpdate({
      target: [animeMappings.provider, animeMappings.providerId],
      set: {
        providerSlug: sql`excluded.provider_slug`,
        providerUrl: sql`excluded.provider_url`,
        confidence: sql`greatest(${animeMappings.confidence}, excluded.confidence)`,
        source: sql`case
          when ${animeMappings.source} in ('manual', 'api', 'system')
            then ${animeMappings.source}
          else excluded.source
        end`,
        isPrimary: sql`excluded.is_primary`,
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

// Given an AniList anime already in the DB, find and persist its Kitsu mapping.
export async function syncKitsuFromAnilist(
  anilistId: string,
  hints: MatchHints,
): Promise<KitsuSyncResult> {
  // Resolve which DB anime this AniList ID belongs to
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

  const kitsuData = mapKitsuAnime(kitsuNode);
  await insertKitsuMapping(
    existingAnilist.animeId,
    kitsuData,
    isAuthoritativeAnilistMatch(kitsuNode, anilistId),
  );

  const episodeCount = await syncKitsuEpisodes(existingAnilist.animeId, kitsuNode.id);

  return {
    matched: true,
    kitsuId: kitsuNode.id,
    kitsuSlug: kitsuNode.slug,
    data: kitsuData,
    episodeCount,
  };
}

// Fetch and return Kitsu episode data for enrichment (does not write to DB —
// let the caller decide how to store it).
export async function fetchKitsuEpisodeData(
  kitsuId: string,
): Promise<MappedEpisode[]> {
  const nodes = await fetchKitsuEpisodes(kitsuId);
  return mapKitsuEpisodes(nodes);
}

const EPISODE_CHUNK = 100;

// Upsert episodes + episode_mappings for a Kitsu anime. Returns count written.
export async function syncKitsuEpisodes(
  animeId: number,
  kitsuAnimeId: string,
): Promise<number> {
  const mapped = await fetchKitsuEpisodeData(kitsuAnimeId);
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
          title:         sql`coalesce(excluded.title, episodes.title)`,
          titleRomaji:   sql`coalesce(excluded.title_romaji, episodes.title_romaji)`,
          titleEnglish:  sql`coalesce(excluded.title_english, episodes.title_english)`,
          synopsis:      sql`coalesce(excluded.synopsis, episodes.synopsis)`,
          airDate:       sql`coalesce(excluded.air_date, episodes.air_date)`,
          thumbnail:     sql`coalesce(excluded.thumbnail, episodes.thumbnail)`,
          lengthMinutes: sql`coalesce(excluded.length_minutes, episodes.length_minutes)`,
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
        confidence:            100,
        source:                "api" as const,
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
          providerSlug:           sql`excluded.provider_slug`,
          providerUrl:            sql`excluded.provider_url`,
          providerEpisodeNumber:  sql`excluded.provider_episode_number`,
          confidence:             sql`excluded.confidence`,
          source:                 sql`excluded.source`,
          updatedAt:              sql`now()`,
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
