export const MAX_PREFIX_BOUNDARY_DATE_DELTA_DAYS = 180;

export type PrefixSegmentRejectReason =
  | "metadata-count-unavailable"
  | "authoritative-season-not-contiguous"
  | "provider-season-not-larger-than-target"
  | "target-local-coverage-mismatch"
  | "target-transform-not-zero-prefix"
  | "target-not-strict-majority"
  | "missing-prefix-provider-episode-unmapped"
  | "missing-prefix-owned-by-other-anime"
  | "target-start-date-unavailable"
  | "target-end-date-unavailable"
  | "provider-prefix-boundary-airdate-unavailable"
  | "provider-prefix-start-date-mismatch"
  | "provider-prefix-end-date-mismatch";

export interface PrefixAuthoritativeEpisode {
  providerEpisodeNumber: number;
  airDate: string | null;
}

export interface PrefixSegmentTransformEvidence {
  offset: number;
  inferredProviderEpisodeStart: number;
  inferredProviderEpisodeEnd: number;
  observedPairCount: number;
}

export interface PrefixEpisodeOwnership {
  providerEpisodeNumber: number;
  animeId: number;
}

export interface PrefixSegmentEvidenceInput {
  authoritativeEpisodes: PrefixAuthoritativeEpisode[];
  targetMetadataEpisodeCount: number | null;
  targetLocalNormalEpisodeNumbers: number[];
  targetTransform: PrefixSegmentTransformEvidence;
  observedTargetProviderEpisodeNumbers: number[];
  ownership: PrefixEpisodeOwnership[];
  targetAnimeId: number;
  currentOwnerAnimeId: number;
  targetStartDate: string | null;
  targetEndDate: string | null;
}

export interface PrefixSegmentEvidenceResult {
  ok: boolean;
  reason: PrefixSegmentRejectReason | null;
  providerEpisodeStart: number | null;
  providerEpisodeEnd: number | null;
  targetObservedEpisodeCount: number;
  targetCoverageRatio: number | null;
  missingProviderEpisodeNumbers: number[];
  missingOwnerAnimeIds: number[];
  providerPrefixFirstAirDate: string | null;
  providerPrefixLastAirDate: string | null;
  startDateDeltaDays: number | null;
  endDateDeltaDays: number | null;
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

function dateDeltaDays(a: string | null, b: string | null): number | null {
  const left = parseIsoDate(a);
  const right = parseIsoDate(b);
  if (left === null || right === null) return null;
  return Math.round(Math.abs(left - right) / (24 * 60 * 60 * 1000));
}

function exactRange(values: number[], end: number): boolean {
  if (values.length !== end) return false;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.every((value, index) => value === index + 1);
}

function baseResult(input: PrefixSegmentEvidenceInput): PrefixSegmentEvidenceResult {
  return {
    ok: false,
    reason: null,
    providerEpisodeStart: null,
    providerEpisodeEnd: null,
    targetObservedEpisodeCount: new Set(input.observedTargetProviderEpisodeNumbers).size,
    targetCoverageRatio: null,
    missingProviderEpisodeNumbers: [],
    missingOwnerAnimeIds: [],
    providerPrefixFirstAirDate: null,
    providerPrefixLastAirDate: null,
    startDateDeltaDays: null,
    endDateDeltaDays: null,
  };
}

export function classifyPrefixSegmentEvidence(
  input: PrefixSegmentEvidenceInput,
): PrefixSegmentEvidenceResult {
  const result = baseResult(input);
  const targetCount = input.targetMetadataEpisodeCount;
  if (!Number.isInteger(targetCount) || (targetCount ?? 0) <= 0) {
    result.reason = "metadata-count-unavailable";
    return result;
  }
  const n = targetCount!;

  const authoritative = [...input.authoritativeEpisodes].sort(
    (a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber,
  );
  if (
    authoritative.length === 0 ||
    authoritative.some((episode, index) => episode.providerEpisodeNumber !== index + 1)
  ) {
    result.reason = "authoritative-season-not-contiguous";
    return result;
  }
  if (authoritative.length <= n) {
    result.reason = "provider-season-not-larger-than-target";
    return result;
  }
  if (!exactRange(input.targetLocalNormalEpisodeNumbers, n)) {
    result.reason = "target-local-coverage-mismatch";
    return result;
  }

  result.providerEpisodeStart = 1;
  result.providerEpisodeEnd = n;
  result.targetCoverageRatio = result.targetObservedEpisodeCount / n;

  if (
    input.targetTransform.offset !== 0 ||
    input.targetTransform.inferredProviderEpisodeStart !== 1 ||
    input.targetTransform.inferredProviderEpisodeEnd !== n
  ) {
    result.reason = "target-transform-not-zero-prefix";
    return result;
  }

  const observed = new Set(input.observedTargetProviderEpisodeNumbers);
  if (
    [...observed].some((number) => !Number.isInteger(number) || number < 1 || number > n) ||
    observed.size !== input.targetTransform.observedPairCount
  ) {
    result.reason = "target-transform-not-zero-prefix";
    return result;
  }
  if (observed.size * 2 <= n) {
    result.reason = "target-not-strict-majority";
    return result;
  }

  const ownershipByNumber = new Map<number, number[]>();
  for (const owner of input.ownership) {
    const owners = ownershipByNumber.get(owner.providerEpisodeNumber) ?? [];
    owners.push(owner.animeId);
    ownershipByNumber.set(owner.providerEpisodeNumber, owners);
  }

  const missing: number[] = [];
  const missingOwners = new Set<number>();
  for (let number = 1; number <= n; number += 1) {
    if (observed.has(number)) continue;
    missing.push(number);
    const owners = ownershipByNumber.get(number) ?? [];
    if (owners.length === 0) {
      result.missingProviderEpisodeNumbers = missing;
      result.reason = "missing-prefix-provider-episode-unmapped";
      return result;
    }
    if (owners.length !== 1 || owners[0] !== input.currentOwnerAnimeId) {
      for (const ownerAnimeId of owners) missingOwners.add(ownerAnimeId);
      result.missingProviderEpisodeNumbers = missing;
      result.missingOwnerAnimeIds = [...missingOwners].sort((a, b) => a - b);
      result.reason = "missing-prefix-owned-by-other-anime";
      return result;
    }
    missingOwners.add(owners[0]);
  }
  result.missingProviderEpisodeNumbers = missing;
  result.missingOwnerAnimeIds = [...missingOwners].sort((a, b) => a - b);

  const firstAirDate = authoritative[0]?.airDate?.trim() || null;
  const lastAirDate = authoritative[n - 1]?.airDate?.trim() || null;
  result.providerPrefixFirstAirDate = firstAirDate;
  result.providerPrefixLastAirDate = lastAirDate;

  if (parseIsoDate(input.targetStartDate) === null) {
    result.reason = "target-start-date-unavailable";
    return result;
  }
  if (parseIsoDate(input.targetEndDate) === null) {
    result.reason = "target-end-date-unavailable";
    return result;
  }
  if (parseIsoDate(firstAirDate) === null || parseIsoDate(lastAirDate) === null) {
    result.reason = "provider-prefix-boundary-airdate-unavailable";
    return result;
  }

  result.startDateDeltaDays = dateDeltaDays(input.targetStartDate, firstAirDate);
  result.endDateDeltaDays = dateDeltaDays(input.targetEndDate, lastAirDate);
  if (
    result.startDateDeltaDays === null ||
    result.startDateDeltaDays > MAX_PREFIX_BOUNDARY_DATE_DELTA_DAYS
  ) {
    result.reason = "provider-prefix-start-date-mismatch";
    return result;
  }
  if (
    result.endDateDeltaDays === null ||
    result.endDateDeltaDays > MAX_PREFIX_BOUNDARY_DATE_DELTA_DAYS
  ) {
    result.reason = "provider-prefix-end-date-mismatch";
    return result;
  }

  result.ok = true;
  result.reason = null;
  return result;
}
