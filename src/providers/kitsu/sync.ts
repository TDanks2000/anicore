import { and, eq, sql } from "drizzle-orm";

import { db } from "../../db";
import { animeMappings, episodes, episodeMappings } from "../../db/schema";
import { searchKitsuByTitle, fetchKitsuEpisodes, type KitsuSearchNode } from "./client";
import { mapKitsuAnime, mapKitsuEpisodes, type MappedEpisode } from "./mapper";
import type { ProviderAnimeData } from "../types";

export interface MatchHints {
  titleRomaji: string;
  titleEnglish?: string | null;
  season?: string | null;
  seasonYear?: number | null;
  episodeCount?: number | null;
}

export type KitsuSyncResult =
  | { matched: true; kitsuId: string; kitsuSlug: string | null; data: ProviderAnimeData; episodeCount: number }
  | { matched: false };

// Word-overlap similarity in [0, 1]. Ignores punctuation and casing.
function titleSimilarity(a: string, b: string): number {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .trim();

  const aWords = normalize(a).split(/\s+/).filter(Boolean);
  const bWords = new Set(normalize(b).split(/\s+/).filter(Boolean));

  if (aWords.length === 0 || bWords.size === 0) return 0;

  const overlap = aWords.filter((w) => bWords.has(w)).length;
  return overlap / Math.max(aWords.length, bWords.size);
}

// Scores a Kitsu candidate against AniList hints.
// Max possible: 100 pts (year 30 + season 20 + episodeCount 15 + title 35)
function scoreCandidate(node: KitsuSearchNode, hints: MatchHints): number {
  let score = 0;

  const nodeYear = node.startDate
    ? parseInt(node.startDate.trim().split("-")[0]!, 10)
    : null;

  if (hints.seasonYear && nodeYear) {
    if (nodeYear === hints.seasonYear) {
      score += 30;
    } else if (Math.abs(nodeYear - hints.seasonYear) === 1) {
      // Off-by-one year sometimes happens for cross-year season splits
      score += 8;
    }
  }

  if (hints.season && node.season) {
    if (node.season.toUpperCase() === hints.season.toUpperCase()) {
      score += 20;
    }
  }

  if (hints.episodeCount && node.episodeCount) {
    if (node.episodeCount === hints.episodeCount) {
      score += 15;
    } else if (Math.abs(node.episodeCount - hints.episodeCount) <= 2) {
      score += 5;
    }
  }

  // Collect all Kitsu titles to compare against all AniList titles
  const kitsuTitles = [
    node.titles?.romanized,
    node.titles?.translated,
    node.titles?.original,
    ...(node.titles?.alternatives ?? []),
    ...Object.values(node.titles?.localized ?? {}),
  ].filter((t): t is string => Boolean(t));

  const anilistTitles = [hints.titleRomaji, hints.titleEnglish].filter(
    (t): t is string => Boolean(t),
  );

  let bestTitleScore = 0;
  for (const kt of kitsuTitles) {
    for (const at of anilistTitles) {
      bestTitleScore = Math.max(bestTitleScore, titleSimilarity(kt, at));
    }
  }

  score += Math.round(bestTitleScore * 35);

  return score;
}

const MATCH_THRESHOLD = 45;

// Search Kitsu with one title string, return scored candidates.
// Throws on API/network errors so callers can report them properly.
async function searchAndScore(
  title: string,
  hints: MatchHints,
): Promise<Array<{ node: KitsuSearchNode; score: number }>> {
  const nodes = await searchKitsuByTitle(title);
  return nodes.map((node) => ({ node, score: scoreCandidate(node, hints) }));
}

export async function findKitsuMatch(
  hints: MatchHints,
): Promise<KitsuSearchNode | null> {
  // Try romaji first; if we don't get a confident result, also try english
  const romajiCandidates = await searchAndScore(hints.titleRomaji, hints);

  const bestRomaji = romajiCandidates.sort((a, b) => b.score - a.score)[0];
  if (bestRomaji && bestRomaji.score >= MATCH_THRESHOLD) {
    return bestRomaji.node;
  }

  if (hints.titleEnglish && hints.titleEnglish !== hints.titleRomaji) {
    const englishCandidates = await searchAndScore(hints.titleEnglish, hints);

    // Merge both sets and pick global best
    const all = [...romajiCandidates, ...englishCandidates];
    const seen = new Set<string>();
    const deduped = all.filter(({ node }) => {
      if (seen.has(node.id)) return false;
      seen.add(node.id);
      return true;
    });

    const best = deduped.sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= MATCH_THRESHOLD) {
      return best.node;
    }
  }

  return null;
}

async function insertKitsuMapping(
  animeId: number,
  kitsuData: ProviderAnimeData,
): Promise<void> {
  await db
    .insert(animeMappings)
    .values({
      animeId,
      provider: "kitsu",
      providerId: kitsuData.providerId,
      providerSlug: kitsuData.providerSlug ?? null,
      providerUrl: kitsuData.providerUrl ?? null,
      confidence: 90,
      source: "fuzzy",
      isPrimary: false,
    })
    .onConflictDoNothing();
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
  await insertKitsuMapping(existingAnilist.animeId, kitsuData);

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
    await db
      .insert(episodeMappings)
      .values(mappingRows.slice(i, i + EPISODE_CHUNK))
      .onConflictDoUpdate({
        target: [episodeMappings.provider, episodeMappings.providerId],
        set: {
          episodeId:              sql`excluded.episode_id`,
          providerSlug:           sql`excluded.provider_slug`,
          providerUrl:            sql`excluded.provider_url`,
          providerEpisodeNumber:  sql`excluded.provider_episode_number`,
          confidence:             sql`excluded.confidence`,
          source:                 sql`excluded.source`,
          updatedAt:              sql`now()`,
        },
      });
  }

  return mapped.length;
}
