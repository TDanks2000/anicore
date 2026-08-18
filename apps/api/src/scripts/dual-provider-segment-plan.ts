export type AdjacentOwnershipClassification =
  | "owner-then-orphan-adjacent"
  | "orphan-then-owner-adjacent";

export interface ProviderEpisodeAlignmentRow {
  animeId: number;
  providerEpisodeId: string;
  providerEpisodeNumber: number;
  localEpisodeNumber: number;
  localKind: string;
}

export interface AlignedProviderSegment {
  animeId: number;
  providerEpisodeStart: number;
  providerEpisodeEnd: number;
  localEpisodeStart: number;
  localEpisodeEnd: number;
  offset: number;
  episodeCount: number;
}

export type AlignmentRejectReason =
  | "empty-episode-range"
  | "non-normal-local-episode"
  | "invalid-episode-number"
  | "duplicate-provider-episode-number"
  | "duplicate-local-episode-number"
  | "non-contiguous-provider-range"
  | "non-contiguous-local-range"
  | "non-linear-local-alignment";

export interface AlignmentOutcome {
  segment: AlignedProviderSegment | null;
  reason: AlignmentRejectReason | null;
}

export interface DualSegmentPlanOutcome {
  ownerSegment: AlignedProviderSegment | null;
  orphanSegment: AlignedProviderSegment | null;
  reason:
    | AlignmentRejectReason
    | "not-adjacent-ownership"
    | "segment-order-mismatch"
    | null;
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function buildAlignedProviderSegment(
  animeId: number,
  rows: ProviderEpisodeAlignmentRow[],
): AlignmentOutcome {
  if (rows.length === 0) {
    return { segment: null, reason: "empty-episode-range" };
  }
  if (rows.some((row) => row.localKind !== "normal")) {
    return { segment: null, reason: "non-normal-local-episode" };
  }
  if (
    rows.some(
      (row) =>
        row.animeId !== animeId ||
        !positiveInteger(row.providerEpisodeNumber) ||
        !positiveInteger(row.localEpisodeNumber),
    )
  ) {
    return { segment: null, reason: "invalid-episode-number" };
  }

  const sorted = [...rows].sort(
    (a, b) =>
      a.providerEpisodeNumber - b.providerEpisodeNumber ||
      a.localEpisodeNumber - b.localEpisodeNumber,
  );
  const providerNumbers = sorted.map((row) => row.providerEpisodeNumber);
  const localNumbers = sorted.map((row) => row.localEpisodeNumber);
  if (new Set(providerNumbers).size !== rows.length) {
    return { segment: null, reason: "duplicate-provider-episode-number" };
  }
  if (new Set(localNumbers).size !== rows.length) {
    return { segment: null, reason: "duplicate-local-episode-number" };
  }

  for (let index = 1; index < sorted.length; index += 1) {
    if (providerNumbers[index] !== providerNumbers[index - 1]! + 1) {
      return { segment: null, reason: "non-contiguous-provider-range" };
    }
    if (localNumbers[index] !== localNumbers[index - 1]! + 1) {
      return { segment: null, reason: "non-contiguous-local-range" };
    }
  }

  const offset = providerNumbers[0]! - localNumbers[0]!;
  if (
    sorted.some(
      (row) => row.providerEpisodeNumber - row.localEpisodeNumber !== offset,
    )
  ) {
    return { segment: null, reason: "non-linear-local-alignment" };
  }

  return {
    segment: {
      animeId,
      providerEpisodeStart: providerNumbers[0]!,
      providerEpisodeEnd: providerNumbers[providerNumbers.length - 1]!,
      localEpisodeStart: localNumbers[0]!,
      localEpisodeEnd: localNumbers[localNumbers.length - 1]!,
      offset,
      episodeCount: rows.length,
    },
    reason: null,
  };
}

export function buildDualProviderSegmentPlan(
  classification: string,
  ownerAnimeId: number,
  ownerRows: ProviderEpisodeAlignmentRow[],
  orphanAnimeId: number,
  orphanRows: ProviderEpisodeAlignmentRow[],
): DualSegmentPlanOutcome {
  if (
    classification !== "owner-then-orphan-adjacent" &&
    classification !== "orphan-then-owner-adjacent"
  ) {
    return {
      ownerSegment: null,
      orphanSegment: null,
      reason: "not-adjacent-ownership",
    };
  }

  const owner = buildAlignedProviderSegment(ownerAnimeId, ownerRows);
  if (!owner.segment) {
    return {
      ownerSegment: null,
      orphanSegment: null,
      reason: owner.reason,
    };
  }
  const orphan = buildAlignedProviderSegment(orphanAnimeId, orphanRows);
  if (!orphan.segment) {
    return {
      ownerSegment: owner.segment,
      orphanSegment: null,
      reason: orphan.reason,
    };
  }

  const ownerBeforeOrphan =
    owner.segment.providerEpisodeEnd + 1 ===
    orphan.segment.providerEpisodeStart;
  const orphanBeforeOwner =
    orphan.segment.providerEpisodeEnd + 1 ===
    owner.segment.providerEpisodeStart;
  if (
    (classification === "owner-then-orphan-adjacent" && !ownerBeforeOrphan) ||
    (classification === "orphan-then-owner-adjacent" && !orphanBeforeOwner)
  ) {
    return {
      ownerSegment: owner.segment,
      orphanSegment: orphan.segment,
      reason: "segment-order-mismatch",
    };
  }

  return {
    ownerSegment: owner.segment,
    orphanSegment: orphan.segment,
    reason: null,
  };
}
