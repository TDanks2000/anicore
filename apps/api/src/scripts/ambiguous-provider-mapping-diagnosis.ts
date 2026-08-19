import { titleSimilarity } from "@anicore/providers/title-similarity";

export const MIN_AMBIGUOUS_MAPPING_TITLE_SIMILARITY = 0.72;
export const MAX_AMBIGUOUS_MAPPING_YEAR_DISTANCE = 1;
export const MAX_AMBIGUOUS_MAPPING_COUNT_DISTANCE = 2;

export interface AmbiguousMappingAnimeIdentity {
  animeId: number;
  titleRomaji: string;
  titleEnglish: string | null;
  titleNative: string | null;
  titleUserPreferred: string | null;
  synonymsJson: string;
  episodeCount: number | null;
  startDate: string | null;
  format: string | null;
  seasonYear: number | null;
}

export interface AmbiguousMappingProviderEvidence {
  providerSeriesName: string | null;
  providerSlug: string | null;
  providerFirstAired: string | null;
  providerSeasonFirstAired: string | null;
  providerSeasonEpisodeCount: number | null;
  providerShowEpisodeCount: number | null;
}

export type AmbiguousMappingCandidateClassification =
  | "strong-match"
  | "likely-match"
  | "indeterminate"
  | "mismatch";

export type AmbiguousMappingGroupVerdict =
  | "exactly-one-strong-match"
  | "multiple-strong-match"
  | "no-strong-match"
  | "no-candidates";

export interface AmbiguousMappingCandidateSignal {
  bestTitleSimilarity: number;
  bestProviderTitle: string | null;
  bestAnimeTitle: string | null;
  titleMatch: boolean;
  dateExact: boolean;
  yearDistance: number | null;
  yearMatch: boolean;
  countDistance: number | null;
  countMatch: boolean;
}

export interface AmbiguousMappingCandidateDiagnosis {
  provider: "thetvdb" | "tmdb";
  providerId: string;
  providerUrl: string | null;
  source: string;
  confidence: number;
  isPrimary: boolean;
  classification: AmbiguousMappingCandidateClassification;
  evidence: AmbiguousMappingProviderEvidence | null;
  signal: AmbiguousMappingCandidateSignal | null;
}

export interface AmbiguousMappingGroupDiagnosis {
  animeId: number;
  verdict: AmbiguousMappingGroupVerdict;
  strongMatchCount: number;
  likelyMatchCount: number;
  indeterminateCount: number;
  mismatchCount: number;
  candidates: AmbiguousMappingCandidateDiagnosis[];
}

export interface AmbiguousMappingDiagnosisInput {
  anime: AmbiguousMappingAnimeIdentity;
  candidates: Array<{
    provider: "thetvdb" | "tmdb";
    providerId: string;
    providerUrl: string | null;
    source: string;
    confidence: number;
    isPrimary: boolean;
    evidence: AmbiguousMappingProviderEvidence | null;
  }>;
}

function parseSynonyms(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  } catch {
    return [];
  }
}

export function animeIdentityTitlesForAmbiguous(meta: AmbiguousMappingAnimeIdentity): string[] {
  const seen = new Set<string>();
  const titles: string[] = [];
  const values = [
    meta.titleRomaji,
    meta.titleEnglish,
    meta.titleNative,
    meta.titleUserPreferred,
    ...parseSynonyms(meta.synonymsJson),
  ];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(trimmed);
  }
  return titles;
}

function providerTitles(evidence: AmbiguousMappingProviderEvidence): string[] {
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const value of [evidence.providerSeriesName, evidence.providerSlug]) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(trimmed);
  }
  return titles;
}

function parseYear(value: string | null): number | null {
  if (!value) return null;
  const year = Number(value.slice(0, 4));
  return Number.isInteger(year) && year >= 1900 ? year : null;
}

function parseCount(value: number | null): number | null {
  if (value === null) return null;
  return Number.isInteger(value) && value > 0 ? value : null;
}

function distance(a: number, b: number): number {
  return Math.abs(a - b);
}

export function classifyAmbiguousMappingCandidate(
  anime: AmbiguousMappingAnimeIdentity,
  evidence: AmbiguousMappingProviderEvidence | null,
): { classification: AmbiguousMappingCandidateClassification; signal: AmbiguousMappingCandidateSignal | null } {
  if (!evidence) return { classification: "indeterminate", signal: null };

  const animeTitles = animeIdentityTitlesForAmbiguous(anime);
  const providerNames = providerTitles(evidence);

  let bestTitleSimilarity = 0;
  let bestProviderTitle: string | null = null;
  let bestAnimeTitle: string | null = null;
  for (const providerTitle of providerNames) {
    for (const animeTitle of animeTitles) {
      const score = titleSimilarity(providerTitle, animeTitle);
      if (score > bestTitleSimilarity) {
        bestTitleSimilarity = score;
        bestProviderTitle = providerTitle;
        bestAnimeTitle = animeTitle;
      }
    }
  }
  const titleMatch = bestTitleSimilarity >= MIN_AMBIGUOUS_MAPPING_TITLE_SIMILARITY;

  const showFirstAiredYear = parseYear(evidence.providerFirstAired);
  const seasonFirstAiredYear = parseYear(evidence.providerSeasonFirstAired);
  const animeStartYear = parseYear(anime.startDate) ?? anime.seasonYear;
  const dateExact =
    (Boolean(evidence.providerFirstAired?.trim()) &&
      evidence.providerFirstAired === anime.startDate) ||
    (Boolean(evidence.providerSeasonFirstAired?.trim()) &&
      evidence.providerSeasonFirstAired === anime.startDate);
  const yearCandidates = [showFirstAiredYear, seasonFirstAiredYear].filter(
    (value): value is number => value !== null,
  );
  const yearDistance =
    yearCandidates.length > 0 && animeStartYear !== null
      ? Math.min(...yearCandidates.map((year) => distance(year, animeStartYear)))
      : null;
  const yearMatch =
    yearDistance !== null && yearDistance <= MAX_AMBIGUOUS_MAPPING_YEAR_DISTANCE;

  const providerCount = parseCount(evidence.providerSeasonEpisodeCount);
  const animeCount = parseCount(anime.episodeCount);
  const countDistance =
    providerCount !== null && animeCount !== null
      ? distance(providerCount, animeCount)
      : null;
  const countMatch =
    countDistance !== null && countDistance <= MAX_AMBIGUOUS_MAPPING_COUNT_DISTANCE;

  const signal: AmbiguousMappingCandidateSignal = {
    bestTitleSimilarity,
    bestProviderTitle,
    bestAnimeTitle,
    titleMatch,
    dateExact,
    yearDistance,
    yearMatch,
    countDistance,
    countMatch,
  };

  let classification: AmbiguousMappingCandidateClassification;
  if (titleMatch && (dateExact || (yearMatch && countMatch))) {
    classification = "strong-match";
  } else if (!titleMatch && (yearDistance === null || yearDistance > 2)) {
    classification = "mismatch";
  } else if (titleMatch && (yearMatch || countMatch)) {
    classification = "likely-match";
  } else {
    classification = "indeterminate";
  }

  return { classification, signal };
}

export function diagnoseAmbiguousMappingGroup(
  input: AmbiguousMappingDiagnosisInput,
): AmbiguousMappingGroupDiagnosis {
  const candidates = input.candidates.map<AmbiguousMappingCandidateDiagnosis>(
    (candidate) => {
      const { classification, signal } = classifyAmbiguousMappingCandidate(
        input.anime,
        candidate.evidence,
      );
      return {
        provider: candidate.provider,
        providerId: candidate.providerId,
        providerUrl: candidate.providerUrl,
        source: candidate.source,
        confidence: candidate.confidence,
        isPrimary: candidate.isPrimary,
        classification,
        evidence: candidate.evidence,
        signal,
      };
    },
  );

  const strongMatchCount = candidates.filter(
    (candidate) => candidate.classification === "strong-match",
  ).length;
  const likelyMatchCount = candidates.filter(
    (candidate) => candidate.classification === "likely-match",
  ).length;
  const indeterminateCount = candidates.filter(
    (candidate) => candidate.classification === "indeterminate",
  ).length;
  const mismatchCount = candidates.filter(
    (candidate) => candidate.classification === "mismatch",
  ).length;

  let verdict: AmbiguousMappingGroupVerdict;
  if (candidates.length === 0) {
    verdict = "no-candidates";
  } else if (strongMatchCount === 1) {
    verdict = "exactly-one-strong-match";
  } else if (strongMatchCount > 1) {
    verdict = "multiple-strong-match";
  } else {
    verdict = "no-strong-match";
  }

  candidates.sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.providerId.localeCompare(b.providerId),
  );

  return {
    animeId: input.anime.animeId,
    verdict,
    strongMatchCount,
    likelyMatchCount,
    indeterminateCount,
    mismatchCount,
    candidates,
  };
}
