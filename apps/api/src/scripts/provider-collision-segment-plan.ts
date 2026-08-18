import {
  deriveOrphanParentEvidence,
  isWeakAutomaticOrphanEpisodeMapping,
  type OrphanEpisodeMappingRow,
} from "./orphan-episode-parent-repair";

export type CollisionProvider = "thetvdb" | "tmdb";

export interface CollisionEpisodeMappingRow extends OrphanEpisodeMappingRow {
  localEpisodeNumber: number;
  localNormalEpisodeCount: number;
}

export interface ResolvedCollisionGroup {
  animeId: number;
  provider: CollisionProvider;
  providerId: string;
  providerSlug: string | null;
  providerUrl: string | null;
  confidence: number;
  rows: CollisionEpisodeMappingRow[];
}

export type SegmentRejectReason =
  | "stronger-or-manual-evidence"
  | "invalid-local-coverage"
  | "invalid-provider-numbering"
  | "non-linear-numbering"
  | "conflicting-provider-identity";

export interface CollisionSegmentCandidate {
  animeId: number;
  provider: CollisionProvider;
  providerId: string;
  providerSlug: string | null;
  providerUrl: string | null;
  confidence: number;
  source: "fuzzy";
  providerEpisodeStart: number;
  providerEpisodeEnd: number;
  localEpisodeStart: number;
  localEpisodeEnd: number;
  offset: number;
  episodeMappingCount: number;
  episodeMappingIds: number[];
}

export interface SegmentPlanOutcome {
  candidate: CollisionSegmentCandidate | null;
  reason: SegmentRejectReason | null;
}

export interface TmdbCollisionGroupPlan {
  groups: ResolvedCollisionGroup[];
  rejected: Array<{
    animeId: number;
    episodeMappingCount: number;
    reason: SegmentRejectReason;
  }>;
}

function parsePositiveInteger(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function groupKey(row: Pick<CollisionEpisodeMappingRow, "animeId" | "provider">): string {
  return `${row.animeId}\u0000${row.provider}`;
}

function identityKey(candidate: Pick<CollisionSegmentCandidate, "provider" | "providerId">): string {
  return `${candidate.provider}\u0000${candidate.providerId}`;
}

export function buildTmdbResolvedCollisionGroups(
  rows: CollisionEpisodeMappingRow[],
): TmdbCollisionGroupPlan {
  const grouped = new Map<string, CollisionEpisodeMappingRow[]>();
  for (const row of rows) {
    if (row.provider !== "tmdb") continue;
    const key = groupKey(row);
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }

  const groups: ResolvedCollisionGroup[] = [];
  const rejected: TmdbCollisionGroupPlan["rejected"] = [];

  for (const group of grouped.values()) {
    const first = group[0]!;
    if (!group.every(isWeakAutomaticOrphanEpisodeMapping)) {
      rejected.push({
        animeId: first.animeId,
        episodeMappingCount: group.length,
        reason: "stronger-or-manual-evidence",
      });
      continue;
    }

    const evidence = group.map(deriveOrphanParentEvidence);
    if (evidence.some((item) => item === null)) {
      rejected.push({
        animeId: first.animeId,
        episodeMappingCount: group.length,
        reason: "conflicting-provider-identity",
      });
      continue;
    }

    const validEvidence = evidence as Array<{
      providerId: string;
      providerUrl: string | null;
    }>;
    const providerIds = new Set(validEvidence.map((item) => item.providerId));
    if (providerIds.size !== 1) {
      rejected.push({
        animeId: first.animeId,
        episodeMappingCount: group.length,
        reason: "conflicting-provider-identity",
      });
      continue;
    }

    const parent = validEvidence[0]!;
    groups.push({
      animeId: first.animeId,
      provider: "tmdb",
      providerId: parent.providerId,
      providerSlug: null,
      providerUrl: parent.providerUrl,
      confidence: Math.min(85, ...group.map((row) => row.confidence)),
      rows: [...group],
    });
  }

  groups.sort((a, b) => a.animeId - b.animeId);
  rejected.sort((a, b) => a.animeId - b.animeId);
  return { groups, rejected };
}

export function buildLinearCollisionSegment(
  group: ResolvedCollisionGroup,
): SegmentPlanOutcome {
  if (!group.rows.every(isWeakAutomaticOrphanEpisodeMapping)) {
    return { candidate: null, reason: "stronger-or-manual-evidence" };
  }

  const expectedCounts = new Set(
    group.rows.map((row) => parsePositiveInteger(row.localNormalEpisodeCount)),
  );
  if (expectedCounts.has(null) || expectedCounts.size !== 1) {
    return { candidate: null, reason: "invalid-local-coverage" };
  }
  const expectedCount = [...expectedCounts][0]!;
  if (group.rows.length !== expectedCount) {
    return { candidate: null, reason: "invalid-local-coverage" };
  }

  const normalized = group.rows.map((row) => ({
    row,
    localNumber: parsePositiveInteger(row.localEpisodeNumber),
    providerNumber: parsePositiveInteger(row.providerEpisodeNumber),
  }));
  if (normalized.some((item) => item.localNumber === null)) {
    return { candidate: null, reason: "invalid-local-coverage" };
  }
  if (normalized.some((item) => item.providerNumber === null)) {
    return { candidate: null, reason: "invalid-provider-numbering" };
  }

  const byLocal = normalized
    .map((item) => ({
      row: item.row,
      localNumber: item.localNumber!,
      providerNumber: item.providerNumber!,
    }))
    .sort((a, b) => a.localNumber - b.localNumber);

  const localNumbers = byLocal.map((item) => item.localNumber);
  const providerNumbers = byLocal.map((item) => item.providerNumber);
  if (
    new Set(localNumbers).size !== expectedCount ||
    new Set(providerNumbers).size !== expectedCount
  ) {
    return { candidate: null, reason: "non-linear-numbering" };
  }

  for (let index = 0; index < expectedCount; index += 1) {
    if (localNumbers[index] !== index + 1) {
      return { candidate: null, reason: "invalid-local-coverage" };
    }
    if (
      index > 0 &&
      providerNumbers[index] !== providerNumbers[index - 1]! + 1
    ) {
      return { candidate: null, reason: "non-linear-numbering" };
    }
  }

  const providerEpisodeStart = providerNumbers[0]!;
  const providerEpisodeEnd = providerNumbers[providerNumbers.length - 1]!;
  const localEpisodeStart = localNumbers[0]!;
  const localEpisodeEnd = localNumbers[localNumbers.length - 1]!;
  const offset = providerEpisodeStart - localEpisodeStart;

  if (
    !byLocal.every(
      (item) => item.providerNumber - item.localNumber === offset,
    )
  ) {
    return { candidate: null, reason: "non-linear-numbering" };
  }

  return {
    candidate: {
      animeId: group.animeId,
      provider: group.provider,
      providerId: group.providerId,
      providerSlug: group.providerSlug,
      providerUrl: group.providerUrl,
      confidence: group.confidence,
      source: "fuzzy",
      providerEpisodeStart,
      providerEpisodeEnd,
      localEpisodeStart,
      localEpisodeEnd,
      offset,
      episodeMappingCount: group.rows.length,
      episodeMappingIds: group.rows
        .map((row) => row.episodeMappingId)
        .sort((a, b) => a - b),
    },
    reason: null,
  };
}

function rangesOverlap(
  a: Pick<CollisionSegmentCandidate, "providerEpisodeStart" | "providerEpisodeEnd">,
  b: Pick<CollisionSegmentCandidate, "providerEpisodeStart" | "providerEpisodeEnd">,
): boolean {
  return (
    a.providerEpisodeStart <= b.providerEpisodeEnd &&
    b.providerEpisodeStart <= a.providerEpisodeEnd
  );
}

export function filterOverlappingCollisionSegments(candidates: CollisionSegmentCandidate[]): {
  candidates: CollisionSegmentCandidate[];
  rejected: CollisionSegmentCandidate[];
} {
  const byIdentity = new Map<string, CollisionSegmentCandidate[]>();
  for (const candidate of candidates) {
    const key = identityKey(candidate);
    const group = byIdentity.get(key) ?? [];
    group.push(candidate);
    byIdentity.set(key, group);
  }

  const rejectedSet = new Set<CollisionSegmentCandidate>();
  for (const group of byIdentity.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const a = group[left]!;
        const b = group[right]!;
        if (a.animeId !== b.animeId && rangesOverlap(a, b)) {
          rejectedSet.add(a);
          rejectedSet.add(b);
        }
      }
    }
  }

  return {
    candidates: candidates.filter((candidate) => !rejectedSet.has(candidate)),
    rejected: candidates.filter((candidate) => rejectedSet.has(candidate)),
  };
}
