import {
  normalizeComparableTitle,
  titleSimilarity,
} from "../title-similarity";
import { searchKitsuByTitle, type KitsuSearchNode } from "./client";

export interface MatchHints {
  anilistId?: string;
  /** AniList's `idMal`. Kitsu publishes MYANIMELIST_ANIME cross-references far
   *  more widely than ANILIST_ANIME ones, so this is the denser anchor. */
  malId?: string;
  titleRomaji: string;
  titleEnglish?: string | null;
  titleNative?: string | null;
  synonyms?: string[];
  season?: string | null;
  seasonYear?: number | null;
  /** ISO `YYYY-MM-DD` premiere date. Far sharper evidence than seasonYear, and
   *  frequently present on entries that have no seasonYear at all. */
  startDate?: string | null;
  episodeCount?: number | null;
  format?: string | null;
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
const MAX_FALLBACK_SEARCH_TITLES = 4;

// Premiere-date agreement. An exact date is the single most discriminating
// signal available for separating entries in the same franchise, which is where
// near-tied candidates overwhelmingly come from.
const EXACT_START_DATE_SCORE = 40;
const CLOSE_START_DATE_SCORE = 22;
const NEAR_START_DATE_SCORE = 10;
const CLOSE_START_DATE_DAYS = 7;
const NEAR_START_DATE_DAYS = 31;
// Two records more than roughly a year apart are different entries even when
// their titles agree; this catches sequels that seasonYear alone lets through.
const CONFLICTING_START_DATE_DAYS = 400;

// Exact catalogue-type agreement. Not a conflict rule — differing types are
// tolerated elsewhere because catalogues classify inconsistently — but when the
// types do agree it is real evidence, and it is what separates a series from
// the short/mini-anime spin-off that shares its title, date and episode count.
const FORMAT_AGREEMENT_SCORE = 12;

const MS_PER_DAY = 86_400_000;

/** Maps an AniList format onto Kitsu's `subtype` vocabulary. */
function canonicalFormat(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) return null;
  // Kitsu has no TV_SHORT; it files those under TV.
  if (normalized === "TV_SHORT") return "TV";
  return normalized;
}

function hasFormatAgreement(node: KitsuSearchNode, hints: MatchHints): boolean {
  const hintFormat = canonicalFormat(hints.format);
  const nodeFormat = canonicalFormat(node.subtype);
  return hintFormat !== null && nodeFormat !== null && hintFormat === nodeFormat;
}

const EMPTY_TITLE_SET: ReadonlySet<string> = new Set<string>();

function parseIsoDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(time) ? time : null;
}

function startDateDistanceDays(
  node: KitsuSearchNode,
  hints: MatchHints,
): number | null {
  const hintTime = parseIsoDate(hints.startDate);
  const nodeTime = parseIsoDate(node.startDate);
  if (hintTime === null || nodeTime === null) return null;
  return Math.abs(hintTime - nodeTime) / MS_PER_DAY;
}

function externalIdsFor(node: KitsuSearchNode, site: string): string[] {
  return (
    node.mappings?.nodes
      .filter((mapping) => mapping.externalSite === site)
      .map((mapping) => mapping.externalId.trim())
      .filter((externalId) => externalId.length > 0) ?? []
  );
}

function anilistMappingsFor(node: KitsuSearchNode): string[] {
  return externalIdsFor(node, "ANILIST_ANIME");
}

function malMappingsFor(node: KitsuSearchNode): string[] {
  return externalIdsFor(node, "MYANIMELIST_ANIME");
}

export function isAuthoritativeAnilistMatch(
  node: KitsuSearchNode,
  anilistId: string | undefined,
): boolean {
  return Boolean(anilistId && anilistMappingsFor(node).includes(anilistId));
}

export function isAuthoritativeMalMatch(
  node: KitsuSearchNode,
  malId: string | undefined,
): boolean {
  return Boolean(malId && malMappingsFor(node).includes(malId));
}

/**
 * Whether a published cross-reference proves this candidate is the right record.
 *
 * Kitsu exposes both AniList and MyAnimeList cross-references on the same
 * payload we already fetch, but only the AniList side was ever consulted.
 * Measured across the fuzzy-matched tail, Kitsu publishes a MAL reference
 * roughly two-and-a-half times as often as an AniList one, so consulting both
 * converts a large slice of guesses into certainties at no extra request cost.
 */
export function isAuthoritativeMatch(
  node: KitsuSearchNode,
  hints: MatchHints,
): boolean {
  return (
    isAuthoritativeAnilistMatch(node, hints.anilistId) ||
    isAuthoritativeMalMatch(node, hints.malId)
  );
}

export function kitsuSearchTitles(
  hints: MatchHints,
): { primary: string[]; fallback: string[] } {
  const seen = new Set<string>();
  const unique = (values: Array<string | null | undefined>): string[] => {
    const result: string[] = [];
    for (const value of values) {
      const title = value?.trim();
      if (!title) continue;
      const key = normalizeComparableTitle(title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(title);
    }
    return result;
  };

  const primary = unique([hints.titleRomaji, hints.titleEnglish]);
  const fallback = unique([
    hints.titleNative,
    ...(hints.synonyms ?? []),
  ]).slice(0, MAX_FALLBACK_SEARCH_TITLES);

  return { primary, fallback };
}

export function kitsuNodeTitles(node: KitsuSearchNode): string[] {
  return [...kitsuPrimaryTitles(node), ...kitsuSecondaryTitles(node)];
}

/**
 * The titles Kitsu presents as this record's own name. A work is never listed
 * under an umbrella or franchise banner here, so these are always identity
 * evidence and are never discounted.
 */
function kitsuPrimaryTitles(node: KitsuSearchNode): string[] {
  return [node.titles?.romanized, node.titles?.translated].filter(
    (title): title is string => Boolean(title),
  );
}

/**
 * Alternative/original/localized titles. These are where shared branding shows
 * up — a franchise banner, or an anthology programme name repeated on every
 * entry underneath it — so only these are eligible for the shared-title
 * discount.
 */
function kitsuSecondaryTitles(node: KitsuSearchNode): string[] {
  return [
    node.titles?.original,
    ...(node.titles?.alternatives ?? []),
    ...Object.values(node.titles?.localized ?? {}),
  ].filter((title): title is string => Boolean(title));
}

function bestTitleSimilarity(
  node: KitsuSearchNode,
  hints: MatchHints,
  sharedTitles: ReadonlySet<string> = EMPTY_TITLE_SET,
): number {
  const kitsuTitles = [
    ...kitsuPrimaryTitles(node),
    ...kitsuSecondaryTitles(node).filter(
      (title) => !sharedTitles.has(normalizeComparableTitle(title)),
    ),
  ];
  const anilistTitles = [
    hints.titleRomaji,
    hints.titleEnglish,
    hints.titleNative,
    ...(hints.synonyms ?? []),
  ].filter((title): title is string => Boolean(title));

  let best = 0;
  for (const kitsuTitle of kitsuTitles) {
    for (const anilistTitle of anilistTitles) {
      best = Math.max(best, titleSimilarity(kitsuTitle, anilistTitle));
    }
  }
  return best;
}

export function hasKitsuStructuralConflict(
  node: KitsuSearchNode,
  hints: MatchHints,
): boolean {
  const hintFormat = hints.format?.trim().toUpperCase();
  const nodeFormat = node.subtype?.trim().toUpperCase();
  const hintIsMovie = hintFormat === "MOVIE";
  const nodeIsMovie = nodeFormat === "MOVIE";
  const hintIsTv = hintFormat === "TV" || hintFormat === "TV_SHORT";
  const nodeIsTv = nodeFormat === "TV" || nodeFormat === "TV_SHORT";

  if ((hintIsMovie && nodeIsTv) || (nodeIsMovie && hintIsTv)) {
    return true;
  }

  // An exact premiere date on both sides beats the coarse year comparison, and
  // is available on many entries that carry no seasonYear at all.
  const startDateDistance = startDateDistanceDays(node, hints);
  if (startDateDistance !== null && startDateDistance > CONFLICTING_START_DATE_DAYS) {
    return true;
  }

  const nodeYear = node.startDate
    ? Number(node.startDate.trim().split("-")[0])
    : null;

  if (
    hints.seasonYear &&
    nodeYear &&
    Number.isInteger(nodeYear) &&
    Math.abs(nodeYear - hints.seasonYear) > 1
  ) {
    return true;
  }

  // Catalogues legitimately disagree about episode counts for the same work:
  // one may count a half-hour slot as a single episode where the other counts
  // its two segments separately (104 vs 52), or fold recaps and specials in.
  // An exact premiere date plus title agreement already establishes identity,
  // so a counting-convention difference must not veto it. Date and format
  // conflicts above are genuine and still apply.
  const sameExactPremiere = startDateDistance === 0;

  if (
    !sameExactPremiere &&
    hints.episodeCount &&
    hints.episodeCount > 0 &&
    node.episodeCount &&
    node.episodeCount > 0
  ) {
    const ratio = node.episodeCount / hints.episodeCount;
    if (
      hints.episodeCount >= 8 &&
      (ratio < 0.75 || ratio > 1.35)
    ) {
      return true;
    }
    if (
      hints.episodeCount >= 3 &&
      (ratio < 0.5 || ratio > 1.75)
    ) {
      return true;
    }
  }

  return false;
}

export function scoreKitsuCandidate(
  node: KitsuSearchNode,
  hints: MatchHints,
  sharedTitles: ReadonlySet<string> = EMPTY_TITLE_SET,
): number {
  const mappedAnilistIds = anilistMappingsFor(node);
  const mappedMalIds = malMappingsFor(node);

  // A direct Kitsu cross-reference is authoritative, from either catalogue.
  // Check every returned mapping rather than only the first, because one Kitsu
  // record can expose several.
  if (isAuthoritativeMatch(node, hints)) {
    return AUTHORITATIVE_MATCH_SCORE;
  }

  // If Kitsu explicitly maps this candidate to a DIFFERENT anime on a catalogue
  // we hold an id for, it must never be rescued by fuzzy metadata. Each
  // catalogue is judged on its own: a record carrying only a MAL reference says
  // nothing about our AniList id, and vice versa.
  if (hints.anilistId && mappedAnilistIds.length > 0) {
    return CONFLICTING_MAPPING_SCORE;
  }
  if (hints.malId && mappedMalIds.length > 0) {
    return CONFLICTING_MAPPING_SCORE;
  }
  // An incomplete mapping page cannot safely prove the target id is absent.
  if ((hints.anilistId || hints.malId) && node.mappings?.pageInfo?.hasNextPage) {
    return CONFLICTING_MAPPING_SCORE;
  }

  const titleScore = bestTitleSimilarity(node, hints, sharedTitles);
  if (titleScore < MIN_FUZZY_TITLE_SIMILARITY) {
    return CONFLICTING_MAPPING_SCORE;
  }

  // Fuzzy title agreement cannot rescue a candidate that plainly contradicts
  // AniList's known year or episode-count shape. Missing metadata is tolerated;
  // conflicting metadata is not.
  if (hasKitsuStructuralConflict(node, hints)) {
    return CONFLICTING_MAPPING_SCORE;
  }

  let score = 0;

  // Exact premiere dates separate franchise entries that agree on title, year,
  // season and episode count — the shape that previously produced near-ties and
  // therefore abstentions.
  const startDateDistance = startDateDistanceDays(node, hints);
  if (startDateDistance !== null) {
    if (startDateDistance === 0) score += EXACT_START_DATE_SCORE;
    else if (startDateDistance <= CLOSE_START_DATE_DAYS) score += CLOSE_START_DATE_SCORE;
    else if (startDateDistance <= NEAR_START_DATE_DAYS) score += NEAR_START_DATE_SCORE;
  }

  if (hasFormatAgreement(node, hints)) score += FORMAT_AGREEMENT_SCORE;

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

/**
 * Normalized titles that more than one candidate claims.
 *
 * Umbrella and anthology names ("Minna no Uta", long-running NHK music
 * programmes, franchise banners) are published as an alternative title on every
 * entry underneath them, on both AniList and Kitsu. Matching one is therefore
 * evidence of shared branding, not of shared identity: without this, every song
 * in a programme scores a perfect title match against every other song, and the
 * resulting exact tie makes the matcher abstain on all of them.
 *
 * Frequency is measured within the candidate set alone, so no external corpus
 * is needed and the discount only applies when real ambiguity is present.
 *
 * Only SECONDARY titles are counted. A record's own primary title is identity
 * evidence even when relatives share it: "Soul Link" is the real name of the
 * series and merely an alternative title on its specials, so discounting it
 * everywhere would erase the correct record's only evidence.
 */
export function sharedCandidateTitles(
  nodes: KitsuSearchNode[],
): ReadonlySet<string> {
  const counts = new Map<string, number>();

  for (const node of nodes) {
    const seen = new Set<string>();
    for (const title of kitsuSecondaryTitles(node)) {
      const normalized = normalizeComparableTitle(title);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }

  const shared = new Set<string>();
  for (const [title, count] of counts) {
    if (count > 1) shared.add(title);
  }
  return shared;
}

/** Scores a whole candidate set, discounting titles shared across it. */
export function scoreKitsuCandidates(
  nodes: KitsuSearchNode[],
  hints: MatchHints,
): ScoredKitsuCandidate[] {
  const shared = sharedCandidateTitles(nodes);
  return nodes.map((node) => ({
    node,
    score: scoreKitsuCandidate(node, hints, shared),
  }));
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
): Promise<KitsuSearchNode[]> {
  return searchKitsuByTitle(title);
}

function addCandidates(
  nodesById: Map<string, KitsuSearchNode>,
  nodes: KitsuSearchNode[],
): void {
  for (const node of nodes) {
    if (!nodesById.has(node.id)) nodesById.set(node.id, node);
  }
}

export async function findKitsuMatch(
  hints: MatchHints,
): Promise<KitsuSearchNode | null> {
  const searchTitles = kitsuSearchTitles(hints);
  const nodesById = new Map<string, KitsuSearchNode>();

  for (const title of searchTitles.primary) {
    addCandidates(nodesById, await searchAndScore(title, hints));
  }

  // Scoring runs over the whole accumulated candidate set rather than per
  // search, so titles shared across candidates can be recognised and discounted.
  const primaryMatch = selectKitsuMatch(
    scoreKitsuCandidates([...nodesById.values()], hints),
  );
  if (primaryMatch) return primaryMatch;

  // Native titles and AniList synonyms are fallback discovery keys only. Bound
  // the extra searches so difficult titles gain coverage without multiplying
  // requests for the common case where Romaji/English already finds a match.
  for (const title of searchTitles.fallback) {
    addCandidates(nodesById, await searchAndScore(title, hints));
  }

  return selectKitsuMatch(scoreKitsuCandidates([...nodesById.values()], hints));
}
