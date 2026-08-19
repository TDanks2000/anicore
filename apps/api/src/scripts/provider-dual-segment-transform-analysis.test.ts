import { describe, expect, test } from "bun:test";

import { classifyDualSegmentTransforms } from "./provider-dual-segment-transform-analysis";
import type { ObservedSegmentTransform } from "./provider-merged-season-transform-analysis";

function transform(start: number, end: number): ObservedSegmentTransform {
  return {
    offset: start - 1,
    inferredProviderEpisodeStart: start,
    inferredProviderEpisodeEnd: end,
    observedPairCount: 1,
    observedLocalEpisodeStart: 1,
    observedLocalEpisodeEnd: 1,
    observedProviderEpisodeStart: start,
    observedProviderEpisodeEnd: start,
    boundaryEvidence: "local-start-observed",
    observedPairs: [{ localEpisodeNumber: 1, providerEpisodeNumber: start }],
  };
}

describe("classifyDualSegmentTransforms", () => {
  test("recognizes an exact 12+12 provider season partition", () => {
    const result = classifyDualSegmentTransforms({
      target: transform(1, 12),
      owner: transform(13, 24),
      authoritativeEpisodeNumbers: Array.from({ length: 24 }, (_, index) => index + 1),
    });

    expect(result.classification).toBe("exact-provider-partition");
    expect(result.coversAuthoritativeSeason).toBe(true);
    expect(result.overlapEpisodeCount).toBe(0);
    expect(result.gapEpisodeCount).toBe(0);
  });

  test("rejects overlapping inferred segments as a partition", () => {
    const result = classifyDualSegmentTransforms({
      target: transform(1, 13),
      owner: transform(13, 24),
      authoritativeEpisodeNumbers: Array.from({ length: 24 }, (_, index) => index + 1),
    });

    expect(result.classification).toBe("overlapping-inferred-segments");
    expect(result.overlapEpisodeCount).toBe(1);
  });

  test("distinguishes adjacent segments that do not cover the provider season", () => {
    const result = classifyDualSegmentTransforms({
      target: transform(1, 4),
      owner: transform(5, 8),
      authoritativeEpisodeNumbers: Array.from({ length: 23 }, (_, index) => index + 1),
    });

    expect(result.classification).toBe("adjacent-provider-subset");
    expect(result.coversAuthoritativeSeason).toBe(false);
  });
});
