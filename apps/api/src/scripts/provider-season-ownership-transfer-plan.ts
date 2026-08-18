export interface TransferAuthoritativeEpisode {
  providerEpisodeId: string;
  providerEpisodeNumber: number;
}

export interface TransferMappedEpisode {
  episodeMappingId: number;
  providerEpisodeId: string;
  animeId: number;
  episodeId: number;
}

export interface TransferTargetEpisode {
  episodeId: number;
  episodeNumber: number;
  kind: string;
  hasProviderMapping: boolean;
}

export interface EpisodeOwnershipTransferMove {
  episodeMappingId: number;
  providerEpisodeId: string;
  providerEpisodeNumber: number;
  fromEpisodeId: number;
  toEpisodeId: number;
}

export type EpisodeOwnershipTransferRejectReason =
  | "duplicate-provider-episode-number"
  | "missing-authoritative-move-episode"
  | "missing-current-owner-mapping"
  | "wrong-current-owner"
  | "missing-target-episode"
  | "target-episode-not-normal"
  | "target-provider-slot-already-populated";

export interface EpisodeOwnershipTransferPlan {
  moves: EpisodeOwnershipTransferMove[] | null;
  reason: EpisodeOwnershipTransferRejectReason | null;
}

export function planEpisodeOwnershipTransfers(input: {
  currentOwnerAnimeId: number;
  targetAnimeId: number;
  providerEpisodeNumbersToMove: number[];
  authoritativeEpisodes: TransferAuthoritativeEpisode[];
  mappedEpisodes: TransferMappedEpisode[];
  targetEpisodes: TransferTargetEpisode[];
}): EpisodeOwnershipTransferPlan {
  const moveNumbers = [...input.providerEpisodeNumbersToMove].sort((a, b) => a - b);
  if (new Set(moveNumbers).size !== moveNumbers.length) {
    return { moves: null, reason: "duplicate-provider-episode-number" };
  }

  const authoritativeByNumber = new Map(
    input.authoritativeEpisodes.map((episode) => [episode.providerEpisodeNumber, episode]),
  );
  const mappingByProviderId = new Map(
    input.mappedEpisodes.map((mapping) => [mapping.providerEpisodeId, mapping]),
  );
  const targetByNumber = new Map(
    input.targetEpisodes.map((episode) => [episode.episodeNumber, episode]),
  );

  const moves: EpisodeOwnershipTransferMove[] = [];
  for (const providerEpisodeNumber of moveNumbers) {
    const authoritative = authoritativeByNumber.get(providerEpisodeNumber);
    if (!authoritative) {
      return { moves: null, reason: "missing-authoritative-move-episode" };
    }

    const current = mappingByProviderId.get(authoritative.providerEpisodeId);
    if (!current) {
      return { moves: null, reason: "missing-current-owner-mapping" };
    }
    if (current.animeId !== input.currentOwnerAnimeId) {
      return { moves: null, reason: "wrong-current-owner" };
    }

    const target = targetByNumber.get(providerEpisodeNumber);
    if (!target) {
      return { moves: null, reason: "missing-target-episode" };
    }
    if (target.kind !== "normal") {
      return { moves: null, reason: "target-episode-not-normal" };
    }
    if (target.hasProviderMapping) {
      return { moves: null, reason: "target-provider-slot-already-populated" };
    }

    moves.push({
      episodeMappingId: current.episodeMappingId,
      providerEpisodeId: authoritative.providerEpisodeId,
      providerEpisodeNumber,
      fromEpisodeId: current.episodeId,
      toEpisodeId: target.episodeId,
    });
  }

  return { moves, reason: null };
}
