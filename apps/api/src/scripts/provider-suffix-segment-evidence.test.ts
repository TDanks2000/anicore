import { describe, expect, test } from "bun:test";

import { analyzeSuffixSegmentEvidence } from "./provider-suffix-segment-evidence";

function season(count: number, startDay = 1) {
  return Array.from({ length: count }, (_, index) => ({
    providerEpisodeNumber: index + 1,
    airDate: `2024-01-${String(startDay + index).padStart(2, "0")}`,
  }));
}

describe("analyzeSuffixSegmentEvidence", () => {
  test("recognizes an exact mapped suffix with a non-zero provider offset", () => {
    const result = analyzeSuffixSegmentEvidence({
      authoritativeEpisodes: season(24),
      prefixEnd: 12,
      mappedEpisodes: Array.from({ length: 12 }, (_, index) => ({
        providerEpisodeNumber: index + 13,
        animeId: 2,
        localEpisodeNumber: index + 1,
        localKind: "normal",
      })),
      animeCandidates: [
        {
          animeId: 2,
          episodeCount: 12,
          localNormalEpisodeNumbers: Array.from({ length: 12 }, (_, index) => index + 1),
          startDate: "2024-01-13",
          endDate: "2024-01-24",
          directlyRelatedToTarget: true,
        },
      ],
      currentOwnerAnimeId: 99,
    });

    expect(result.suffixStart).toBe(13);
    expect(result.suffixEnd).toBe(24);
    expect(result.exactMappedSuffixAnimeId).toBe(2);
    expect(result.uniqueRelatedSuffixCandidateAnimeId).toBe(2);
  });

  test("can identify a unique related suffix candidate when provider suffix IDs are unmapped", () => {
    const result = analyzeSuffixSegmentEvidence({
      authoritativeEpisodes: season(8),
      prefixEnd: 4,
      mappedEpisodes: [],
      animeCandidates: [
        {
          animeId: 3,
          episodeCount: 4,
          localNormalEpisodeNumbers: [1, 2, 3, 4],
          startDate: "2024-01-05",
          endDate: "2024-01-08",
          directlyRelatedToTarget: true,
        },
      ],
      currentOwnerAnimeId: 3,
    });

    expect(result.exactMappedSuffixAnimeId).toBeNull();
    expect(result.uniqueRelatedSuffixCandidateAnimeId).toBe(3);
    expect(result.currentOwnerMatchesSuffixMetadata).toBe(true);
  });

  test("does not accept overlapping zero-offset mappings as an exact suffix", () => {
    const result = analyzeSuffixSegmentEvidence({
      authoritativeEpisodes: season(6),
      prefixEnd: 3,
      mappedEpisodes: [
        { providerEpisodeNumber: 4, animeId: 7, localEpisodeNumber: 4, localKind: "normal" },
        { providerEpisodeNumber: 5, animeId: 7, localEpisodeNumber: 5, localKind: "normal" },
        { providerEpisodeNumber: 6, animeId: 7, localEpisodeNumber: 6, localKind: "normal" },
      ],
      animeCandidates: [
        {
          animeId: 7,
          episodeCount: 3,
          localNormalEpisodeNumbers: [1, 2, 3],
          startDate: "2024-01-04",
          endDate: "2024-01-06",
          directlyRelatedToTarget: true,
        },
      ],
      currentOwnerAnimeId: 7,
    });

    expect(result.exactMappedSuffixAnimeId).toBeNull();
    expect(result.uniqueRelatedSuffixCandidateAnimeId).toBe(7);
  });

  test("rejects ambiguous related suffix candidates", () => {
    const candidates = [10, 11].map((animeId) => ({
      animeId,
      episodeCount: 2,
      localNormalEpisodeNumbers: [1, 2],
      startDate: "2024-01-03",
      endDate: "2024-01-04",
      directlyRelatedToTarget: true,
    }));
    const result = analyzeSuffixSegmentEvidence({
      authoritativeEpisodes: season(4),
      prefixEnd: 2,
      mappedEpisodes: [],
      animeCandidates: candidates,
      currentOwnerAnimeId: 10,
    });

    expect(result.uniqueRelatedSuffixCandidateAnimeId).toBeNull();
  });
});
