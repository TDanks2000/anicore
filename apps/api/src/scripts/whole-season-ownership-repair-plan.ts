export interface WholeSeasonAuthoritativeEpisode {
  providerEpisodeId: string;
  providerEpisodeNumber: number;
}

export interface WholeSeasonMappedEpisode {
  providerEpisodeId: string;
  animeId: number;
  localEpisodeNumber: number;
  localKind: string;
}

export type WholeSeasonRepairRejectReason =
  | "invalid-authoritative-numbering"
  | "target-local-count-mismatch"
  | "target-local-numbering-invalid"
  | "owner-also-full-season-sized"
  | "unmapped-provider-episodes"
  | "third-anime-involved"
  | "target-mapping-number-mismatch"
  | "owner-does-not-fill-target-gaps"
  | "target-not-majority-owner"
  | "nothing-to-move";

export interface WholeSeasonOwnershipRepairCandidate {
  targetAnimeId: number;
  currentOwnerAnimeId: number;
  authoritativeEpisodeCount: number;
  targetOwnedEpisodeCount: number;
  ownerOwnedEpisodeCount: number;
  providerEpisodeNumbersToMove: number[];
}

export interface WholeSeasonOwnershipRepairPlan {
  candidate: WholeSeasonOwnershipRepairCandidate | null;
  reason: WholeSeasonRepairRejectReason | null;
}

function normalizedOneToN(values: number[]): boolean {
  const sorted = [...values].sort((a, b) => a - b);
  if (new Set(sorted).size !== sorted.length) return false;
  return sorted.every((value, index) => value === index + 1);
}

export function planWholeSeasonOwnershipRepair(input: {
  targetAnimeId: number;
  currentOwnerAnimeId: number;
  authoritativeEpisodes: WholeSeasonAuthoritativeEpisode[];
  mappedEpisodes: WholeSeasonMappedEpisode[];
  targetNormalEpisodeNumbers: number[];
  ownerNormalEpisodeCount: number;
}): WholeSeasonOwnershipRepairPlan {
  const {
    targetAnimeId,
    currentOwnerAnimeId,
    authoritativeEpisodes,
    mappedEpisodes,
    targetNormalEpisodeNumbers,
    ownerNormalEpisodeCount,
  } = input;

  const authoritative = [...authoritativeEpisodes].sort(
    (a, b) => a.providerEpisodeNumber - b.providerEpisodeNumber,
  );
  const authoritativeNumbers = authoritative.map(
    (episode) => episode.providerEpisodeNumber,
  );
  const authoritativeIds = new Set(
    authoritative.map((episode) => episode.providerEpisodeId),
  );
  if (
    authoritative.length === 0 ||
    !normalizedOneToN(authoritativeNumbers) ||
    authoritativeIds.size !== authoritative.length
  ) {
    return { candidate: null, reason: "invalid-authoritative-numbering" };
  }

  const expectedCount = authoritative.length;
  if (targetNormalEpisodeNumbers.length !== expectedCount) {
    return { candidate: null, reason: "target-local-count-mismatch" };
  }
  if (!normalizedOneToN(targetNormalEpisodeNumbers)) {
    return { candidate: null, reason: "target-local-numbering-invalid" };
  }
  if (ownerNormalEpisodeCount === expectedCount) {
    return { candidate: null, reason: "owner-also-full-season-sized" };
  }

  const mappingByProviderId = new Map(
    mappedEpisodes.map((mapping) => [mapping.providerEpisodeId, mapping]),
  );
  const targetOwnedNumbers: number[] = [];
  const ownerOwnedNumbers: number[] = [];

  for (const episode of authoritative) {
    const mapping = mappingByProviderId.get(episode.providerEpisodeId);
    if (!mapping) {
      return { candidate: null, reason: "unmapped-provider-episodes" };
    }
    if (mapping.localKind !== "normal") {
      return { candidate: null, reason: "third-anime-involved" };
    }
    if (mapping.animeId === targetAnimeId) {
      if (mapping.localEpisodeNumber !== episode.providerEpisodeNumber) {
        return { candidate: null, reason: "target-mapping-number-mismatch" };
      }
      targetOwnedNumbers.push(episode.providerEpisodeNumber);
      continue;
    }
    if (mapping.animeId === currentOwnerAnimeId) {
      ownerOwnedNumbers.push(episode.providerEpisodeNumber);
      continue;
    }
    return { candidate: null, reason: "third-anime-involved" };
  }

  if (ownerOwnedNumbers.length === 0) {
    return { candidate: null, reason: "nothing-to-move" };
  }

  const targetOwnedSet = new Set(targetOwnedNumbers);
  const missingTargetNumbers = authoritativeNumbers.filter(
    (number) => !targetOwnedSet.has(number),
  );
  const sortedOwnerNumbers = [...ownerOwnedNumbers].sort((a, b) => a - b);
  if (
    missingTargetNumbers.length !== sortedOwnerNumbers.length ||
    missingTargetNumbers.some(
      (number, index) => number !== sortedOwnerNumbers[index],
    )
  ) {
    return { candidate: null, reason: "owner-does-not-fill-target-gaps" };
  }

  if (targetOwnedNumbers.length <= ownerOwnedNumbers.length) {
    return { candidate: null, reason: "target-not-majority-owner" };
  }

  return {
    candidate: {
      targetAnimeId,
      currentOwnerAnimeId,
      authoritativeEpisodeCount: expectedCount,
      targetOwnedEpisodeCount: targetOwnedNumbers.length,
      ownerOwnedEpisodeCount: ownerOwnedNumbers.length,
      providerEpisodeNumbersToMove: sortedOwnerNumbers,
    },
    reason: null,
  };
}
