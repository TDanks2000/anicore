import { searchKitsuByTitle, type KitsuSearchNode } from "./client";

export interface MatchHints {
  anilistId?: string;
  titleRomaji: string;
  titleEnglish?: string | null;
  season?: string | null;
  seasonYear?: number | null;
  episodeCount?: number | null;
}

const MATCH_THRESHOLD = 45;
const AUTHORITATIVE_MATCH_SCORE = 1_000;
const CONFLICTING_MAPPING_SCORE = -1;

function anilistMappingFor(node: KitsuSearchNode): string | null {
  return (
    node.mappings?.nodes.find(
      (mapping) => mapping.externalSite === "ANILIST_ANIME",
    )?.externalId ?? null
  );
}

export function isAuthoritativeAnilistMatch(
  node: KitsuSearchNode,
  anilistId: string | undefined,
): boolean {
  return Boolean(anilistId && anilistMappingFor(node) === anilistId);
}

function titleSimilarity(a: string, b: string): number {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .trim();

  const aWords = normalize(a).split(/\s+/).filter(Boolean);
  const bWords = new Set(normalize(b).split(/\s+/).filter(Boolean));
  if (aWords.length === 0 || bWords.size === 0) return 0;

  const overlap = aWords.filter((word) => bWords.has(word)).length;
  return overlap / Math.max(aWords.length, bWords.size);
}

export function scoreKitsuCandidate(
  node: KitsuSearchNode,
  hints: MatchHints,
): number {
  const mappedAnilistId = anilistMappingFor(node);
  // Kitsu's direct AniList link is authoritative over title metadata.
  if (hints.anilistId && mappedAnilistId) {
    return mappedAnilistId === hints.anilistId
      ? AUTHORITATIVE_MATCH_SCORE
      : CONFLICTING_MAPPING_SCORE;
  }
  if (hints.anilistId && node.mappings?.pageInfo?.hasNextPage) {
    return CONFLICTING_MAPPING_SCORE;
  }

  let score = 0;
  const nodeYear = node.startDate
    ? parseInt(node.startDate.trim().split("-")[0]!, 10)
    : null;

  if (hints.seasonYear && nodeYear) {
    if (nodeYear === hints.seasonYear) score += 30;
    else if (Math.abs(nodeYear - hints.seasonYear) === 1) score += 8;
  }
  if (
    hints.season &&
    node.season?.toUpperCase() === hints.season.toUpperCase()
  ) {
    score += 20;
  }
  if (hints.episodeCount && node.episodeCount) {
    if (node.episodeCount === hints.episodeCount) score += 15;
    else if (Math.abs(node.episodeCount - hints.episodeCount) <= 2) score += 5;
  }

  const kitsuTitles = [
    node.titles?.romanized,
    node.titles?.translated,
    node.titles?.original,
    ...(node.titles?.alternatives ?? []),
    ...Object.values(node.titles?.localized ?? {}),
  ].filter((title): title is string => Boolean(title));
  const anilistTitles = [hints.titleRomaji, hints.titleEnglish].filter(
    (title): title is string => Boolean(title),
  );

  let bestTitleScore = 0;
  for (const kitsuTitle of kitsuTitles) {
    for (const anilistTitle of anilistTitles) {
      bestTitleScore = Math.max(
        bestTitleScore,
        titleSimilarity(kitsuTitle, anilistTitle),
      );
    }
  }

  return score + Math.round(bestTitleScore * 35);
}

async function searchAndScore(
  title: string,
  hints: MatchHints,
): Promise<Array<{ node: KitsuSearchNode; score: number }>> {
  const nodes = await searchKitsuByTitle(title);
  return nodes.map((node) => ({
    node,
    score: scoreKitsuCandidate(node, hints),
  }));
}

export async function findKitsuMatch(
  hints: MatchHints,
): Promise<KitsuSearchNode | null> {
  const candidates = await searchAndScore(hints.titleRomaji, hints);
  if (hints.titleEnglish && hints.titleEnglish !== hints.titleRomaji) {
    candidates.push(...(await searchAndScore(hints.titleEnglish, hints)));
  }

  const bestById = new Map<string, { node: KitsuSearchNode; score: number }>();
  for (const candidate of candidates) {
    const existing = bestById.get(candidate.node.id);
    if (!existing || candidate.score > existing.score) {
      bestById.set(candidate.node.id, candidate);
    }
  }

  const best = [...bestById.values()].sort((a, b) => b.score - a.score)[0];
  return best && best.score >= MATCH_THRESHOLD ? best.node : null;
}
