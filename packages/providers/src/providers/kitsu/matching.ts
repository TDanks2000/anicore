import { searchKitsuByTitle, type KitsuSearchNode } from "./client";

export interface MatchHints {
  anilistId?: string;
  titleRomaji: string;
  titleEnglish?: string | null;
  season?: string | null;
  seasonYear?: number | null;
  episodeCount?: number | null;
}

export interface ScoredKitsuCandidate {
  node: KitsuSearchNode;
  score: number;
}

const MATCH_THRESHOLD = 45;
const MIN_FUZZY_TITLE_SIMILARITY = 0.5;
const AMBIGUITY_MARGIN = 10;
const AUTHORITATIVE_MATCH_SCORE = 1_000;
const CONFLICTING_MAPPING_SCORE = -1;

function anilistMappingsFor(node: KitsuSearchNode): string[] {
  return (
    node.mappings?.nodes
      .filter((mapping) => mapping.externalSite === "ANILIST_ANIME")
      .map((mapping) => mapping.externalId) ?? []
  );
}

export function isAuthoritativeAnilistMatch(
  node: KitsuSearchNode,
  anilistId: string | undefined,
): boolean {
  return Boolean(anilistId && anilistMappingsFor(node).includes(anilistId));
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(a: string, b: string): number {
  const aWords = normalizeTitle(a).split(/\s+/).filter(Boolean);
  const bWords = new Set(normalizeTitle(b).split(/\s+/).filter(Boolean));
  if (aWords.length === 0 || bWords.size === 0) return 0;

  const overlap = aWords.filter((word) => bWords.has(word)).length;
  return overlap / Math.max(aWords.length, bWords.size);
}

function bestTitleSimilarity(node: KitsuSearchNode, hints: MatchHints): number {
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

  let best = 0;
  for (const kitsuTitle of kitsuTitles) {
    for (const anilistTitle of anilistTitles) {
      best = Math.max(best, titleSimilarity(kitsuTitle, anilistTitle));
    }
  }
  return best;
}

export function scoreKitsuCandidate(
  node: KitsuSearchNode,
  hints: MatchHints,
): number {
  const mappedAnilistIds = anilistMappingsFor(node);

  // A direct Kitsu -> AniList cross-reference is authoritative. Check every
  // returned mapping rather than only the first one because one Kitsu record
  // can expose multiple mappings.
  if (hints.anilistId && mappedAnilistIds.includes(hints.anilistId)) {
    return AUTHORITATIVE_MATCH_SCORE;
  }

  // If Kitsu explicitly maps this candidate to a different AniList anime, it
  // must never be rescued by fuzzy metadata. Likewise, an incomplete mapping
  // page cannot safely prove that the target ID is absent.
  if (hints.anilistId && mappedAnilistIds.length > 0) {
    return CONFLICTING_MAPPING_SCORE;
  }
  if (hints.anilistId && node.mappings?.pageInfo?.hasNextPage) {
    return CONFLICTING_MAPPING_SCORE;
  }

  const titleScore = bestTitleSimilarity(node, hints);
  if (titleScore < MIN_FUZZY_TITLE_SIMILARITY) {
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

  return score + Math.round(titleScore * 35);
}

export function selectKitsuMatch(
  candidates: ScoredKitsuCandidate[],
): KitsuSearchNode | null {
  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < MATCH_THRESHOLD) return null;

  const runnerUp = ranked[1];
  if (
    runnerUp &&
    runnerUp.score >= MATCH_THRESHOLD &&
    best.score - runnerUp.score < AMBIGUITY_MARGIN
  ) {
    return null;
  }

  return best.node;
}

async function searchAndScore(
  title: string,
  hints: MatchHints,
): Promise<ScoredKitsuCandidate[]> {
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

  const bestById = new Map<string, ScoredKitsuCandidate>();
  for (const candidate of candidates) {
    const existing = bestById.get(candidate.node.id);
    if (!existing || candidate.score > existing.score) {
      bestById.set(candidate.node.id, candidate);
    }
  }

  return selectKitsuMatch([...bestById.values()]);
}
