export const MAX_SUFFIX_BOUNDARY_DATE_DELTA_DAYS = 180;

export interface SuffixAuthoritativeEpisode {
  providerEpisodeNumber: number;
  airDate: string | null;
}

export interface SuffixMappedEpisode {
  providerEpisodeNumber: number;
  animeId: number;
  localEpisodeNumber: number;
  localKind: string;
}

export interface SuffixAnimeCandidate {
  animeId: number;
  episodeCount: number | null;
  localNormalEpisodeNumbers: number[];
  startDate: string | null;
  endDate: string | null;
  directlyRelatedToTarget: boolean;
}

export interface SuffixCandidateEvidence {
  animeId: number;
  episodeCountMatches: boolean;
  localCoverageMatches: boolean;
  startDateDeltaDays: number | null;
  endDateDeltaDays: number | null;
  boundaryDatesMatch: boolean;
  directlyRelatedToTarget: boolean;
}

export interface SuffixSegmentEvidenceInput {
  authoritativeEpisodes: SuffixAuthoritativeEpisode[];
  prefixEnd: number;
  mappedEpisodes: SuffixMappedEpisode[];
  animeCandidates: SuffixAnimeCandidate[];
  currentOwnerAnimeId: number;
}

export interface SuffixSegmentEvidenceResult {
  suffixStart: number | null;
  suffixEnd: number | null;
  suffixEpisodeCount: number | null;
  providerSuffixFirstAirDate: string | null;
  providerSuffixLastAirDate: string | null;
  mappedSuffixEpisodeCount: number;
  mappedSuffixAnimeIds: number[];
  exactMappedSuffixAnimeId: number | null;
  uniqueRelatedSuffixCandidateAnimeId: number | null;
  currentOwnerMatchesSuffixMetadata: boolean;
  candidateEvidence: SuffixCandidateEvidence[];
}

function parseIsoDate(value: string | null | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return timestamp;
}

function dateDeltaDays(left: string | null, right: string | null): number | null {
  const a = parseIsoDate(left);
  const b = parseIsoDate(right);
  if (a === null || b === null) return null;
  return Math.round(Math.abs(a - b) / (24 * 60 * 60 * 1000));
}

function exactLocalCoverage(values: number[], count: number): boolean {
  if (values.length !== count) return false;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.every((value, index) => value === index + 1);
}

function candidateEvidence(
  candidate: SuffixAnimeCandidate,
  suffixCount: number,
  firstAirDate: string | null,
  lastAirDate: string | null,
): SuffixCandidateEvidence {
  const startDateDeltaDays = dateDeltaDays(candidate.startDate, firstAirDate);
  const endDateDeltaDays = dateDeltaDays(candidate.endDate, lastAirDate);
  const boundaryDatesMatch =
    startDateDeltaDays !== null &&
    startDateDeltaDays <= MAX_SUFFIX_BOUNDARY_DATE_DELTA_DAYS &&
    endDateDeltaDays !== null &&
    endDateDeltaDays <= MAX_SUFFIX_BOUNDARY_DATE_DELTA_DAYS;

  return {
    animeId: candidate.animeId,
    episodeCountMatches: candidate.episodeCount === suffixCount,
    localCoverageMatches: exactLocalCoverage(candidate.localNormalEpisodeNumbers, suffixCount),
    startDateDeltaDays,
    endDateDeltaDays,
    boundaryDatesMatch,
    directlyRelatedToTarget: candidate.directlyRelatedToTarget,
  };
}

export function analyzeSuffixSegmentEvidence(
  input: SuffixSegmentEvidenceInput,
): SuffixSegmentEvidenceResult {
  const authoritative = [...input.authoritativeEpisodes].sort(
    (a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber,
  );
  const contiguous =
    authoritative.length > 0 &&
    authoritative.every((episode, index) => episode.providerEpisodeNumber === index + 1);
  if (!contiguous || !Number.isInteger(input.prefixEnd) || input.prefixEnd <= 0 || input.prefixEnd >= authoritative.length) {
    return {
      suffixStart: null,
      suffixEnd: null,
      suffixEpisodeCount: null,
      providerSuffixFirstAirDate: null,
      providerSuffixLastAirDate: null,
      mappedSuffixEpisodeCount: 0,
      mappedSuffixAnimeIds: [],
      exactMappedSuffixAnimeId: null,
      uniqueRelatedSuffixCandidateAnimeId: null,
      currentOwnerMatchesSuffixMetadata: false,
      candidateEvidence: [],
    };
  }

  const suffixStart = input.prefixEnd + 1;
  const suffixEnd = authoritative.length;
  const suffixCount = suffixEnd - input.prefixEnd;
  const firstAirDate = authoritative[suffixStart - 1]?.airDate?.trim() || null;
  const lastAirDate = authoritative[suffixEnd - 1]?.airDate?.trim() || null;
  const suffixMappings = input.mappedEpisodes.filter(
    (mapping) =>
      mapping.providerEpisodeNumber >= suffixStart &&
      mapping.providerEpisodeNumber <= suffixEnd,
  );
  const mappedAnimeIds = [...new Set(suffixMappings.map((mapping) => mapping.animeId))].sort(
    (a, b) => a - b,
  );

  const evidence = input.animeCandidates
    .map((candidate) => candidateEvidence(candidate, suffixCount, firstAirDate, lastAirDate))
    .sort((a, b) => a.animeId - b.animeId);
  const evidenceByAnime = new Map(evidence.map((item) => [item.animeId, item]));

  let exactMappedSuffixAnimeId: number | null = null;
  if (suffixMappings.length === suffixCount && mappedAnimeIds.length === 1) {
    const animeId = mappedAnimeIds[0]!;
    const exactNumbers = [...suffixMappings]
      .sort((a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber)
      .every(
        (mapping, index) =>
          mapping.localKind === "normal" &&
          mapping.providerEpisodeNumber === suffixStart + index &&
          mapping.localEpisodeNumber === index + 1,
      );
    const candidate = evidenceByAnime.get(animeId);
    if (
      exactNumbers &&
      candidate?.episodeCountMatches &&
      candidate.localCoverageMatches &&
      candidate.boundaryDatesMatch
    ) {
      exactMappedSuffixAnimeId = animeId;
    }
  }

  const relatedCandidates = evidence.filter(
    (candidate) =>
      candidate.directlyRelatedToTarget &&
      candidate.episodeCountMatches &&
      candidate.localCoverageMatches &&
      candidate.boundaryDatesMatch,
  );
  const uniqueRelatedSuffixCandidateAnimeId =
    relatedCandidates.length === 1 ? relatedCandidates[0]!.animeId : null;
  const currentOwnerEvidence = evidenceByAnime.get(input.currentOwnerAnimeId);

  return {
    suffixStart,
    suffixEnd,
    suffixEpisodeCount: suffixCount,
    providerSuffixFirstAirDate: firstAirDate,
    providerSuffixLastAirDate: lastAirDate,
    mappedSuffixEpisodeCount: suffixMappings.length,
    mappedSuffixAnimeIds: mappedAnimeIds,
    exactMappedSuffixAnimeId,
    uniqueRelatedSuffixCandidateAnimeId,
    currentOwnerMatchesSuffixMetadata: Boolean(
      currentOwnerEvidence?.episodeCountMatches &&
        currentOwnerEvidence.localCoverageMatches &&
        currentOwnerEvidence.boundaryDatesMatch,
    ),
    candidateEvidence: evidence,
  };
}
