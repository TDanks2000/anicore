import { hasConflictingExplicitEpisodeNumbers } from "./episode-title-scoring";
import {
  normalizeComparableTitle,
  titleSimilarity,
} from "./title-similarity";

export const MIN_SOURCE_TITLE_SIMILARITY = 0.5;
export const SOURCE_MATCH_AMBIGUITY_MARGIN = 10;

export interface EpisodeSourceContext {
  seasonYear?: number | null;
  episodeCount?: number | null;
  episodes: Array<{
    number: number;
    airDate?: string | null;
  }>;
}

export interface EpisodeSourceTitle {
  number: number;
  title: string;
  airDate?: string | null;
}

export interface ScoredSourceCandidate<T> {
  value: T;
  score: number;
}

// Kept as named exports for compatibility with the existing provider tests and
// callers, but both now use the same identity-matching implementation as Kitsu.
export const normalizeSourceTitle = normalizeComparableTitle;
export const sourceTitleSimilarity = titleSimilarity;

function earliestEpisodeYear(titles: EpisodeSourceTitle[]): number | null {
  const dates = titles
    .map((episode) => episode.airDate)
    .filter((value): value is string => Boolean(value))
    .sort();
  if (!dates[0]) return null;

  const year = Number(dates[0].slice(0, 4));
  return Number.isInteger(year) && year > 0 ? year : null;
}

export function hasUsableEpisodeNumberAlignment(
  context: EpisodeSourceContext,
  titles: EpisodeSourceTitle[],
): boolean {
  const providerNumbers = titles.map((episode) => episode.number);
  if (
    providerNumbers.some(
      (number) => !Number.isInteger(number) || number <= 0,
    )
  ) {
    return false;
  }

  // Two distinct provider episodes claiming the same canonical number cannot be
  // represented safely by AniCore's one-row-per-episode enrichment model.
  if (new Set(providerNumbers).size !== providerNumbers.length) {
    return false;
  }

  const canonicalEpisodeCount =
    context.episodeCount && context.episodeCount > 0
      ? context.episodeCount
      : null;
  const expectedNumbers = canonicalEpisodeCount
    ? new Set(
        Array.from({ length: canonicalEpisodeCount }, (_, index) => index + 1),
      )
    : new Set(
        context.episodes
          .map((episode) => episode.number)
          .filter((number) => Number.isInteger(number) && number > 0),
      );

  // With no canonical count and no local episode rows, count/year are the only
  // alignment evidence available. Do not invent a numbering assumption here.
  if (expectedNumbers.size === 0) return true;

  const aligned = providerNumbers.filter((number) =>
    expectedNumbers.has(number),
  ).length;
  const comparableCount = Math.min(expectedNumbers.size, providerNumbers.length);
  const requiredAligned = Math.max(1, Math.ceil(comparableCount * 0.75));

  return aligned >= requiredAligned;
}

export function scoreSourceEpisodeBatch(
  context: EpisodeSourceContext,
  titles: EpisodeSourceTitle[],
): number {
  if (
    !titles.length ||
    hasConflictingExplicitEpisodeNumbers(titles) ||
    !hasUsableEpisodeNumberAlignment(context, titles)
  ) {
    return Number.NEGATIVE_INFINITY;
  }

  const canonicalEpisodeCount =
    context.episodeCount && context.episodeCount > 0
      ? context.episodeCount
      : null;
  const knownEpisodeCount = canonicalEpisodeCount ?? context.episodes.length;

  if (canonicalEpisodeCount) {
    const ratio = titles.length / canonicalEpisodeCount;
    if (
      canonicalEpisodeCount >= 8 &&
      (ratio < 0.75 || ratio > 1.35)
    ) {
      return Number.NEGATIVE_INFINITY;
    }
    if (
      canonicalEpisodeCount >= 3 &&
      (ratio < 0.5 || ratio > 1.75)
    ) {
      return Number.NEGATIVE_INFINITY;
    }
  } else if (
    knownEpisodeCount >= 8 &&
    titles.length < Math.ceil(knownEpisodeCount * 0.75)
  ) {
    // With an unknown final episode count we can safely reject a provider batch
    // that is missing many episodes we already know about, but must not reject a
    // larger provider batch merely because the local database is still partial.
    return Number.NEGATIVE_INFINITY;
  }

  const batchYear = earliestEpisodeYear(titles);
  if (batchYear && context.seasonYear) {
    const yearDistance = Math.abs(batchYear - context.seasonYear);
    if (yearDistance > 1) {
      return Number.NEGATIVE_INFINITY;
    }
  }

  const localAirDates = new Map(
    context.episodes
      .filter((episode) => episode.airDate)
      .map((episode) => [episode.number, episode.airDate]),
  );

  let score = 0;
  if (knownEpisodeCount > 0) {
    const diff = Math.abs(titles.length - knownEpisodeCount);
    score += Math.max(0, 30 - diff * 4);
  }

  if (batchYear && context.seasonYear) {
    const yearDistance = Math.abs(batchYear - context.seasonYear);
    score += yearDistance === 0 ? 20 : 8;
  }

  for (const title of titles) {
    const localAirDate = localAirDates.get(title.number);
    if (localAirDate && title.airDate && localAirDate === title.airDate) {
      score += 8;
    }
  }

  // A provider returning more named episodes should help only after count/year
  // validation has established that the batch plausibly represents this season.
  score += titles.filter((title) => title.title.trim().length > 0).length;
  return score;
}

export function selectSourceCandidate<T>(
  candidates: ScoredSourceCandidate<T>[],
): T | null {
  const ranked = candidates
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best) return null;

  const runnerUp = ranked[1];
  if (
    runnerUp &&
    best.score - runnerUp.score < SOURCE_MATCH_AMBIGUITY_MARGIN
  ) {
    return null;
  }

  return best.value;
}
