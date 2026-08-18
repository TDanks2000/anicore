import { describe, expect, test } from "bun:test";

import { analyzeObservedSegmentTransform } from "./provider-merged-season-transform-analysis";

const authoritative = Array.from({ length: 24 }, (_, index) => ({
  providerEpisodeId: `provider-${index + 1}`,
  providerEpisodeNumber: index + 1,
}));

describe("analyzeObservedSegmentTransform", () => {
  test("derives a non-zero provider/local offset from authoritative provider episode IDs", () => {
    const result = analyzeObservedSegmentTransform({
      authoritativeEpisodes: authoritative,
      metadataEpisodeCount: 12,
      observedMappings: [
        { providerEpisodeId: "provider-13", localEpisodeNumber: 1 },
        { providerEpisodeId: "provider-18", localEpisodeNumber: 6 },
        { providerEpisodeId: "provider-24", localEpisodeNumber: 12 },
      ],
    });

    expect(result.reason).toBeNull();
    expect(result.transform).toMatchObject({
      offset: 12,
      inferredProviderEpisodeStart: 13,
      inferredProviderEpisodeEnd: 24,
      boundaryEvidence: "both-boundaries-observed",
    });
  });

  test("keeps an internal-only transform diagnostic but does not invent boundary evidence", () => {
    const result = analyzeObservedSegmentTransform({
      authoritativeEpisodes: authoritative,
      metadataEpisodeCount: 12,
      observedMappings: [
        { providerEpisodeId: "provider-15", localEpisodeNumber: 3 },
        { providerEpisodeId: "provider-20", localEpisodeNumber: 8 },
      ],
    });

    expect(result.reason).toBeNull();
    expect(result.transform).toMatchObject({
      offset: 12,
      inferredProviderEpisodeStart: 13,
      inferredProviderEpisodeEnd: 24,
      boundaryEvidence: "internal-only",
    });
  });

  test("rejects observed mappings that do not share one constant transform", () => {
    expect(
      analyzeObservedSegmentTransform({
        authoritativeEpisodes: authoritative,
        metadataEpisodeCount: 12,
        observedMappings: [
          { providerEpisodeId: "provider-13", localEpisodeNumber: 1 },
          { providerEpisodeId: "provider-19", localEpisodeNumber: 6 },
        ],
      }),
    ).toEqual({
      transform: null,
      reason: "non-linear-observed-transform",
    });
  });

  test("rejects an inferred segment that would extend beyond the provider season", () => {
    expect(
      analyzeObservedSegmentTransform({
        authoritativeEpisodes: authoritative,
        metadataEpisodeCount: 12,
        observedMappings: [
          { providerEpisodeId: "provider-20", localEpisodeNumber: 1 },
        ],
      }),
    ).toEqual({
      transform: null,
      reason: "inferred-segment-outside-provider-season",
    });
  });
});
