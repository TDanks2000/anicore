import { describe, expect, test } from "bun:test";

import { classifyProviderLocalCountMismatch } from "./provider-local-count-mismatch-classification";

describe("classifyProviderLocalCountMismatch", () => {
  test("classifies missing local rows when AniList metadata matches provider count", () => {
    expect(
      classifyProviderLocalCountMismatch({
        authoritativeEpisodeNumbers: [1, 2, 3, 4],
        targetLocalNormalEpisodeNumbers: [1, 2],
        targetMetadataEpisodeCount: 4,
      }),
    ).toEqual({
      classification: "local-short-metadata-exact",
      authoritativeEpisodeCount: 4,
      localNormalEpisodeCount: 2,
      metadataEpisodeCount: 4,
      missingLocalNumbers: [3, 4],
      extraLocalNumbers: [],
      localNormalNumbersContiguousFromOne: true,
    });
  });

  test("classifies extra local rows when AniList metadata matches provider count", () => {
    expect(
      classifyProviderLocalCountMismatch({
        authoritativeEpisodeNumbers: [1, 2, 3],
        targetLocalNormalEpisodeNumbers: [1, 2, 3, 4],
        targetMetadataEpisodeCount: 3,
      })?.classification,
    ).toBe("local-long-metadata-exact");
  });

  test("separates metadata disagreement from local row mismatch", () => {
    expect(
      classifyProviderLocalCountMismatch({
        authoritativeEpisodeNumbers: [1, 2, 3, 4],
        targetLocalNormalEpisodeNumbers: [1, 2],
        targetMetadataEpisodeCount: 2,
      })?.classification,
    ).toBe("local-mismatch-metadata-differs");
  });

  test("returns null when local count already equals provider count", () => {
    expect(
      classifyProviderLocalCountMismatch({
        authoritativeEpisodeNumbers: [1, 2, 3],
        targetLocalNormalEpisodeNumbers: [1, 2, 3],
        targetMetadataEpisodeCount: 3,
      }),
    ).toBeNull();
  });
});
