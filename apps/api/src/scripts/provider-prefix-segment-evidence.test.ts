import { describe, expect, test } from "bun:test";

import { classifyPrefixSegmentEvidence } from "./provider-prefix-segment-evidence";

function authoritative(count: number, start = "2020-01-01") {
  const base = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => ({
    providerEpisodeNumber: index + 1,
    airDate: new Date(base + index * 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
  }));
}

function localRange(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

describe("classifyPrefixSegmentEvidence", () => {
  test("accepts a near-complete zero-offset prefix with the missing first episode owned by the current owner", () => {
    const result = classifyPrefixSegmentEvidence({
      authoritativeEpisodes: authoritative(48),
      targetMetadataEpisodeCount: 24,
      targetLocalNormalEpisodeNumbers: localRange(24),
      targetTransform: {
        offset: 0,
        inferredProviderEpisodeStart: 1,
        inferredProviderEpisodeEnd: 24,
        observedPairCount: 23,
      },
      observedTargetProviderEpisodeNumbers: localRange(24).slice(1),
      ownership: [{ providerEpisodeNumber: 1, animeId: 99 }],
      targetAnimeId: 10,
      currentOwnerAnimeId: 99,
      targetStartDate: "2020-01-01",
      targetEndDate: "2020-06-10",
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.missingProviderEpisodeNumbers).toEqual([1]);
    expect(result.targetCoverageRatio).toBeCloseTo(23 / 24);
  });

  test("rejects a one-episode observation that would guess the rest of the prefix", () => {
    const result = classifyPrefixSegmentEvidence({
      authoritativeEpisodes: authoritative(25),
      targetMetadataEpisodeCount: 13,
      targetLocalNormalEpisodeNumbers: localRange(13),
      targetTransform: {
        offset: 0,
        inferredProviderEpisodeStart: 1,
        inferredProviderEpisodeEnd: 13,
        observedPairCount: 1,
      },
      observedTargetProviderEpisodeNumbers: [13],
      ownership: localRange(12).map((providerEpisodeNumber) => ({
        providerEpisodeNumber,
        animeId: 20,
      })),
      targetAnimeId: 10,
      currentOwnerAnimeId: 20,
      targetStartDate: "2020-01-01",
      targetEndDate: "2020-04-01",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target-not-strict-majority");
  });

  test("rejects a prefix whose first provider episode predates the target by too much", () => {
    const result = classifyPrefixSegmentEvidence({
      authoritativeEpisodes: authoritative(24, "2015-01-01"),
      targetMetadataEpisodeCount: 12,
      targetLocalNormalEpisodeNumbers: localRange(12),
      targetTransform: {
        offset: 0,
        inferredProviderEpisodeStart: 1,
        inferredProviderEpisodeEnd: 12,
        observedPairCount: 11,
      },
      observedTargetProviderEpisodeNumbers: localRange(12).slice(1),
      ownership: [{ providerEpisodeNumber: 1, animeId: 20 }],
      targetAnimeId: 10,
      currentOwnerAnimeId: 20,
      targetStartDate: "2016-01-01",
      targetEndDate: "2016-03-31",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("provider-prefix-start-date-mismatch");
  });

  test("rejects when a missing provider episode belongs to a third anime", () => {
    const result = classifyPrefixSegmentEvidence({
      authoritativeEpisodes: authoritative(24),
      targetMetadataEpisodeCount: 12,
      targetLocalNormalEpisodeNumbers: localRange(12),
      targetTransform: {
        offset: 0,
        inferredProviderEpisodeStart: 1,
        inferredProviderEpisodeEnd: 12,
        observedPairCount: 11,
      },
      observedTargetProviderEpisodeNumbers: localRange(12).slice(1),
      ownership: [{ providerEpisodeNumber: 1, animeId: 30 }],
      targetAnimeId: 10,
      currentOwnerAnimeId: 20,
      targetStartDate: "2020-01-01",
      targetEndDate: "2020-03-20",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing-prefix-owned-by-other-anime");
    expect(result.missingOwnerAnimeIds).toEqual([30]);
  });
});
