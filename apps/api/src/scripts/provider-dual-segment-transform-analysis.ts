import type { ObservedSegmentTransform } from "./provider-merged-season-transform-analysis";

export type DualSegmentClassification =
  | "exact-provider-partition"
  | "adjacent-provider-subset"
  | "disjoint-with-gap"
  | "overlapping-inferred-segments"
  | "same-inferred-segment";

export interface DualSegmentClassificationResult {
  classification: DualSegmentClassification;
  targetRange: [number, number];
  ownerRange: [number, number];
  unionEpisodeCount: number;
  overlapEpisodeCount: number;
  gapEpisodeCount: number;
  coversAuthoritativeSeason: boolean;
}

function rangeSet(start: number, end: number): Set<number> {
  const values = new Set<number>();
  for (let value = start; value <= end; value += 1) values.add(value);
  return values;
}

export function classifyDualSegmentTransforms(input: {
  target: ObservedSegmentTransform;
  owner: ObservedSegmentTransform;
  authoritativeEpisodeNumbers: number[];
}): DualSegmentClassificationResult {
  const targetRange: [number, number] = [
    input.target.inferredProviderEpisodeStart,
    input.target.inferredProviderEpisodeEnd,
  ];
  const ownerRange: [number, number] = [
    input.owner.inferredProviderEpisodeStart,
    input.owner.inferredProviderEpisodeEnd,
  ];

  const targetSet = rangeSet(...targetRange);
  const ownerSet = rangeSet(...ownerRange);
  const overlapEpisodeCount = [...targetSet].filter((value) => ownerSet.has(value)).length;
  const union = new Set([...targetSet, ...ownerSet]);
  const authoritative = new Set(input.authoritativeEpisodeNumbers);
  const coversAuthoritativeSeason =
    union.size === authoritative.size && [...authoritative].every((value) => union.has(value));

  const ordered = [targetRange, ownerRange].sort((a, b) => a[0] - b[0]);
  const gapEpisodeCount = Math.max(0, ordered[1]![0] - ordered[0]![1] - 1);

  let classification: DualSegmentClassification;
  if (targetRange[0] === ownerRange[0] && targetRange[1] === ownerRange[1]) {
    classification = "same-inferred-segment";
  } else if (overlapEpisodeCount > 0) {
    classification = "overlapping-inferred-segments";
  } else if (gapEpisodeCount > 0) {
    classification = "disjoint-with-gap";
  } else if (coversAuthoritativeSeason) {
    classification = "exact-provider-partition";
  } else {
    classification = "adjacent-provider-subset";
  }

  return {
    classification,
    targetRange,
    ownerRange,
    unionEpisodeCount: union.size,
    overlapEpisodeCount,
    gapEpisodeCount,
    coversAuthoritativeSeason,
  };
}
