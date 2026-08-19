import { titleSimilarity } from "@anicore/providers/title-similarity";

export const MIN_AMBIGUOUS_MAPPING_TITLE_SIMILARITY = 0.72;
export const MAX_AMBIGUOUS_MAPPING_YEAR_DISTANCE = 1;
export const MAX_AMBIGUOUS_MAPPING_COUNT_DISTANCE = 2;
export const MIN_AMBIGUOUS_RETIRE_YEAR_DISTANCE = 10;
export const MIN_AMBIGUOUS_RETIRE_COUNT_DISTANCE = 20;

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

export type ProviderEvidenceStatus =
  | "ok"
  | "not-found"
  | "fetch-failed"
  | "malformed";

export interface AmbiguousMappingProviderEvidence {
  status: ProviderEvidenceStatus;
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

export type AmbiguousMappingRepairStatus =
  | "verified-keep"
  | "verified-retire"
  | "not-repair-safe";

export type AmbiguousMappingProofScope = "season" | "show";

export interface AmbiguousMappingCandidateSignal {
  bestTitleSimilarity: number;
  bestProviderTitle: string | null;
  bestAnimeTitle: string | null;
  titleMatch: boolean;
  dateExact: boolean;
  showDateExact: boolean;
  seasonDateExact: boolean;
  yearDistance: number | null;
  yearMatch: boolean;
  countDistance: number | null;
  countMatch: boolean;
  seasonCountDistance: number | null;
  seasonCountMatch: boolean;
  showCountDistance: number | null;
  showCountMatch: boolean;
}

export interface AmbiguousMappingRepairAssessment {
  status: AmbiguousMappingRepairStatus;
  proofScope: AmbiguousMappingProofScope | null;
  blockReason: string | null;
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
  repair: AmbiguousMappingRepairAssessment;
}

export interface AmbiguousMappingGroupDiagnosis {
  animeId: number;
  verdict: AmbiguousMappingGroupVerdict;
  strongMatchCount: number;
  likelyMatchCount: number;
  indeterminateCount: number;
  mismatchCount: number;
  repairSafe: boolean;
  repairBlockReason: string | null;
  verifiedKeepCount: number;
  verifiedRetireCount: number;
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

/**
 * Strict provider-season ID parsing. Accepts exactly two colon-separated
 * positive integer components ("<showId>:<seasonNumber>"); any additional
 * colon component or non-numeric part is rejected.
 */
export function parseProviderSeasonId(providerId: string): { showId: number; seasonNumber: number } | null {
  const parts = providerId.split(":");
  if (parts.length !== 2) return null;
  const showId = Number(parts[0]);
  const seasonNumber = Number(parts[1]);
  if (!Number.isInteger(showId) || showId <= 0) return null;
  if (!Number.isInteger(seasonNumber) || seasonNumber <= 0) return null;
  return { showId, seasonNumber };
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
  if (!evidence || evidence.status !== "ok") {
    return { classification: "indeterminate", signal: null };
  }

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
  const animeStartDate = anime.startDate?.trim() || null;
  const showDateExact =
    Boolean(evidence.providerFirstAired?.trim()) &&
    evidence.providerFirstAired === animeStartDate;
  const seasonDateExact =
    Boolean(evidence.providerSeasonFirstAired?.trim()) &&
    evidence.providerSeasonFirstAired === animeStartDate;
  const dateExact = showDateExact || seasonDateExact;
  const yearCandidates = [showFirstAiredYear, seasonFirstAiredYear].filter(
    (value): value is number => value !== null,
  );
  const yearDistance =
    yearCandidates.length > 0 && animeStartYear !== null
      ? Math.min(...yearCandidates.map((year) => distance(year, animeStartYear)))
      : null;
  const yearMatch =
    yearDistance !== null && yearDistance <= MAX_AMBIGUOUS_MAPPING_YEAR_DISTANCE;

  const animeCount = parseCount(anime.episodeCount);
  const seasonCount = parseCount(evidence.providerSeasonEpisodeCount);
  const showCount = parseCount(evidence.providerShowEpisodeCount);
  const seasonCountDistance =
    seasonCount !== null && animeCount !== null ? distance(seasonCount, animeCount) : null;
  const seasonCountMatch =
    seasonCountDistance !== null &&
    seasonCountDistance <= MAX_AMBIGUOUS_MAPPING_COUNT_DISTANCE;
  const showCountDistance =
    showCount !== null && animeCount !== null ? distance(showCount, animeCount) : null;
  const showCountMatch =
    showCountDistance !== null &&
    showCountDistance <= MAX_AMBIGUOUS_MAPPING_COUNT_DISTANCE;

  const signal: AmbiguousMappingCandidateSignal = {
    bestTitleSimilarity,
    bestProviderTitle,
    bestAnimeTitle,
    titleMatch,
    dateExact,
    showDateExact,
    seasonDateExact,
    yearDistance,
    yearMatch,
    countDistance: seasonCountDistance,
    countMatch: seasonCountMatch,
    seasonCountDistance,
    seasonCountMatch,
    showCountDistance,
    showCountMatch,
  };

  let classification: AmbiguousMappingCandidateClassification;
  if (titleMatch && (dateExact || (yearMatch && seasonCountMatch))) {
    classification = "strong-match";
  } else if (!titleMatch && (yearDistance === null || yearDistance > 2)) {
    classification = "mismatch";
  } else if (titleMatch && (yearMatch || seasonCountMatch)) {
    classification = "likely-match";
  } else {
    classification = "indeterminate";
  }

  return { classification, signal };
}

/**
 * Fail-closed repair eligibility assessment. This is deliberately stricter
 * than the diagnostic classification and is the only layer allowed to
 * authorize a future retirement or keep.
 *
 * A "verified-keep" requires a complete identity proof bound at a single
 * provider scope:
 * - season scope: strong title + season first-air date exactly equal to the
 *   anime start date + season episode count exactly equal to the anime episode
 *   count, with no missing required evidence.
 * - show scope: strong title + show first-air date exactly equal to the anime
 *   start date + show episode count exactly equal to the anime episode count.
 *
 * Show-level and season-level evidence are never mixed (e.g. a show date is
 * never paired with a season count).
 *
 * A "verified-retire" requires positive contradictory provider evidence, not
 * merely a failed title threshold: a title contradiction combined with a
 * substantially wrong first-air year, or a title contradiction combined with a
 * substantially wrong episode count.
 *
 * Everything else is "not-repair-safe" and blocks group repair.
 */
export function assessCandidateRepairSafety(
  anime: AmbiguousMappingAnimeIdentity,
  evidence: AmbiguousMappingProviderEvidence | null,
  signal: AmbiguousMappingCandidateSignal | null,
): AmbiguousMappingRepairAssessment {
  if (!evidence) {
    return {
      status: "not-repair-safe",
      proofScope: null,
      blockReason: "missing-provider-evidence",
    };
  }
  if (evidence.status === "malformed") {
    return {
      status: "not-repair-safe",
      proofScope: null,
      blockReason: "malformed-provider-id",
    };
  }
  if (evidence.status === "not-found") {
    return {
      status: "not-repair-safe",
      proofScope: null,
      blockReason: "provider-entity-not-found",
    };
  }
  if (evidence.status === "fetch-failed") {
    return {
      status: "not-repair-safe",
      proofScope: null,
      blockReason: "provider-fetch-failed",
    };
  }
  if (!signal) {
    return {
      status: "not-repair-safe",
      proofScope: null,
      blockReason: "missing-signals",
    };
  }

  const animeStartDate = anime.startDate?.trim() || null;
  const animeCount = parseCount(anime.episodeCount);

  if (
    signal.titleMatch &&
    animeStartDate !== null &&
    animeCount !== null &&
    evidence.providerSeasonFirstAired === animeStartDate &&
    parseCount(evidence.providerSeasonEpisodeCount) === animeCount
  ) {
    return { status: "verified-keep", proofScope: "season", blockReason: null };
  }

  if (
    signal.titleMatch &&
    animeStartDate !== null &&
    animeCount !== null &&
    evidence.providerFirstAired === animeStartDate &&
    parseCount(evidence.providerShowEpisodeCount) === animeCount
  ) {
    return { status: "verified-keep", proofScope: "show", blockReason: null };
  }

  if (!signal.titleMatch) {
    if (signal.yearDistance !== null && signal.yearDistance >= MIN_AMBIGUOUS_RETIRE_YEAR_DISTANCE) {
      return {
        status: "verified-retire",
        proofScope: null,
        blockReason: "title-contradiction-with-substantially-wrong-year",
      };
    }
    const closestCountDistance = [
      signal.seasonCountDistance,
      signal.showCountDistance,
    ].filter((value): value is number => value !== null);
    if (
      closestCountDistance.length > 0 &&
      Math.min(...closestCountDistance) >= MIN_AMBIGUOUS_RETIRE_COUNT_DISTANCE
    ) {
      return {
        status: "verified-retire",
        proofScope: null,
        blockReason: "title-contradiction-with-substantially-wrong-count",
      };
    }
  }

  return {
    status: "not-repair-safe",
    proofScope: null,
    blockReason: "no-verified-identity-proof-and-no-explicit-contradiction",
  };
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
      const repair = assessCandidateRepairSafety(input.anime, candidate.evidence, signal);
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
        repair,
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

  const verifiedKeep = candidates.filter(
    (candidate) => candidate.repair.status === "verified-keep",
  );
  const verifiedRetire = candidates.filter(
    (candidate) => candidate.repair.status === "verified-retire",
  );
  const notRepairSafe = candidates.filter(
    (candidate) => candidate.repair.status === "not-repair-safe",
  );

  const repairSafe =
    candidates.length >= 2 &&
    verifiedKeep.length === 1 &&
    verifiedRetire.length === candidates.length - 1;

  let repairBlockReason: string | null = null;
  if (!repairSafe) {
    if (candidates.length < 2) {
      repairBlockReason = "ambiguous-group-requires-at-least-two-candidates";
    } else if (verifiedKeep.length === 0) {
      repairBlockReason = "no-verified-keep-candidate";
    } else if (verifiedKeep.length > 1) {
      repairBlockReason = `multiple-verified-keep-candidates: ${verifiedKeep
        .map((candidate) => `${candidate.provider} ${candidate.providerId}`)
        .join(", ")}`;
    } else if (notRepairSafe.length > 0) {
      repairBlockReason = `not-repair-safe-sibling: ${notRepairSafe
        .map(
          (candidate) =>
            `${candidate.provider} ${candidate.providerId} (${candidate.repair.blockReason ?? "unknown"})`,
        )
        .join("; ")}`;
    } else {
      repairBlockReason = "no-verified-retire-sibling";
    }
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
    repairSafe,
    repairBlockReason,
    verifiedKeepCount: verifiedKeep.length,
    verifiedRetireCount: verifiedRetire.length,
    candidates,
  };
}