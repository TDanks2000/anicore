export interface AuthoritativeProviderEpisode {
  providerEpisodeId: string;
  providerEpisodeNumber: number;
}

export interface ObservedProviderMapping {
  providerEpisodeId: string;
  localEpisodeNumber: number;
}

export type SegmentBoundaryEvidence =
  | "both-boundaries-observed"
  | "local-start-observed"
  | "local-end-observed"
  | "internal-only";

export type ObservedTransformRejectReason =
  | "invalid-metadata-count"
  | "missing-authoritative-provider-episode"
  | "invalid-local-episode-number"
  | "duplicate-local-episode-number"
  | "duplicate-provider-episode-number"
  | "non-linear-observed-transform"
  | "inferred-segment-outside-provider-season";

export interface ObservedSegmentTransform {
  offset: number;
  inferredProviderEpisodeStart: number;
  inferredProviderEpisodeEnd: number;
  observedPairCount: number;
  observedLocalEpisodeStart: number;
  observedLocalEpisodeEnd: number;
  observedProviderEpisodeStart: number;
  observedProviderEpisodeEnd: number;
  boundaryEvidence: SegmentBoundaryEvidence;
  observedPairs: Array<{
    localEpisodeNumber: number;
    providerEpisodeNumber: number;
  }>;
}

export interface ObservedSegmentTransformAnalysis {
  transform: ObservedSegmentTransform | null;
  reason: ObservedTransformRejectReason | null;
}

export function analyzeObservedSegmentTransform(input: {
  authoritativeEpisodes: AuthoritativeProviderEpisode[];
  observedMappings: ObservedProviderMapping[];
  metadataEpisodeCount: number | null;
}): ObservedSegmentTransformAnalysis {
  const metadataCount = input.metadataEpisodeCount;
  if (
    typeof metadataCount !== "number" ||
    !Number.isInteger(metadataCount) ||
    metadataCount <= 0
  ) {
    return { transform: null, reason: "invalid-metadata-count" };
  }

  const authoritativeById = new Map(
    input.authoritativeEpisodes.map((episode) => [episode.providerEpisodeId, episode]),
  );
  const authoritativeNumbers = new Set(
    input.authoritativeEpisodes.map((episode) => episode.providerEpisodeNumber),
  );
  if (
    authoritativeById.size !== input.authoritativeEpisodes.length ||
    authoritativeNumbers.size !== input.authoritativeEpisodes.length
  ) {
    return { transform: null, reason: "duplicate-provider-episode-number" };
  }

  const observedPairs: Array<{
    localEpisodeNumber: number;
    providerEpisodeNumber: number;
  }> = [];

  for (const mapping of input.observedMappings) {
    const authoritative = authoritativeById.get(mapping.providerEpisodeId);
    if (!authoritative) {
      return { transform: null, reason: "missing-authoritative-provider-episode" };
    }
    if (
      !Number.isInteger(mapping.localEpisodeNumber) ||
      mapping.localEpisodeNumber <= 0 ||
      mapping.localEpisodeNumber > metadataCount
    ) {
      return { transform: null, reason: "invalid-local-episode-number" };
    }
    observedPairs.push({
      localEpisodeNumber: mapping.localEpisodeNumber,
      providerEpisodeNumber: authoritative.providerEpisodeNumber,
    });
  }

  observedPairs.sort(
    (a, b) =>
      a.localEpisodeNumber - b.localEpisodeNumber ||
      a.providerEpisodeNumber - b.providerEpisodeNumber,
  );

  const localNumbers = observedPairs.map((pair) => pair.localEpisodeNumber);
  const providerNumbers = observedPairs.map((pair) => pair.providerEpisodeNumber);
  if (new Set(localNumbers).size !== localNumbers.length) {
    return { transform: null, reason: "duplicate-local-episode-number" };
  }
  if (new Set(providerNumbers).size !== providerNumbers.length) {
    return { transform: null, reason: "duplicate-provider-episode-number" };
  }
  if (observedPairs.length === 0) {
    return { transform: null, reason: "non-linear-observed-transform" };
  }

  const offset = observedPairs[0]!.providerEpisodeNumber - observedPairs[0]!.localEpisodeNumber;
  if (
    !observedPairs.every(
      (pair) => pair.providerEpisodeNumber - pair.localEpisodeNumber === offset,
    )
  ) {
    return { transform: null, reason: "non-linear-observed-transform" };
  }

  const inferredProviderEpisodeStart = 1 + offset;
  const inferredProviderEpisodeEnd = metadataCount + offset;
  for (
    let providerEpisodeNumber = inferredProviderEpisodeStart;
    providerEpisodeNumber <= inferredProviderEpisodeEnd;
    providerEpisodeNumber += 1
  ) {
    if (providerEpisodeNumber <= 0 || !authoritativeNumbers.has(providerEpisodeNumber)) {
      return { transform: null, reason: "inferred-segment-outside-provider-season" };
    }
  }

  const localStartObserved = localNumbers.includes(1);
  const localEndObserved = localNumbers.includes(metadataCount);
  const boundaryEvidence: SegmentBoundaryEvidence =
    localStartObserved && localEndObserved
      ? "both-boundaries-observed"
      : localStartObserved
        ? "local-start-observed"
        : localEndObserved
          ? "local-end-observed"
          : "internal-only";

  return {
    transform: {
      offset,
      inferredProviderEpisodeStart,
      inferredProviderEpisodeEnd,
      observedPairCount: observedPairs.length,
      observedLocalEpisodeStart: localNumbers[0]!,
      observedLocalEpisodeEnd: localNumbers[localNumbers.length - 1]!,
      observedProviderEpisodeStart: providerNumbers[0]!,
      observedProviderEpisodeEnd: providerNumbers[providerNumbers.length - 1]!,
      boundaryEvidence,
      observedPairs,
    },
    reason: null,
  };
}
