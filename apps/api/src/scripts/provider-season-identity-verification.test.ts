import { describe, expect, test } from "bun:test";

import {
  animeIdentityTitles,
  MIN_PROVIDER_TITLE_SIMILARITY,
  verifyProviderSeasonIdentity,
} from "./provider-season-identity-verification";

const baseAnime = {
  titleRomaji: "Hunter x Hunter",
  titleEnglish: "Hunter × Hunter",
  titleNative: "HUNTER×HUNTER",
  titleUserPreferred: "Hunter x Hunter",
  synonymsJson: JSON.stringify(["HxH"]),
  episodeCount: 62,
};

describe("provider season identity verification", () => {
  test("accepts an exact metadata count and strong provider title match", () => {
    const result = verifyProviderSeasonIdentity({
      anime: baseAnime,
      authoritativeEpisodeCount: 62,
      providerTitles: ["Hunter x Hunter"],
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.bestTitleSimilarity).toBeGreaterThanOrEqual(
      MIN_PROVIDER_TITLE_SIMILARITY,
    );
  });

  test("rejects contaminated local rows when AniList metadata count disagrees", () => {
    const result = verifyProviderSeasonIdentity({
      anime: { ...baseAnime, episodeCount: 1 },
      authoritativeEpisodeCount: 12,
      providerTitles: ["Hunter x Hunter"],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target-metadata-count-mismatch");
  });

  test("rejects unrelated provider titles despite matching episode counts", () => {
    const result = verifyProviderSeasonIdentity({
      anime: baseAnime,
      authoritativeEpisodeCount: 62,
      providerTitles: ["Green Green"],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("provider-title-mismatch");
  });

  test("uses English/native/synonym titles as independent identity evidence", () => {
    const result = verifyProviderSeasonIdentity({
      anime: {
        titleRomaji: "Shingeki no Kyojin",
        titleEnglish: "Attack on Titan",
        titleNative: "進撃の巨人",
        titleUserPreferred: "Shingeki no Kyojin",
        synonymsJson: "[]",
        episodeCount: 25,
      },
      authoritativeEpisodeCount: 25,
      providerTitles: ["Attack on Titan"],
    });

    expect(result.ok).toBe(true);
    expect(result.bestTargetTitle).toBe("Attack on Titan");
  });

  test("deduplicates target titles and tolerates malformed synonym JSON", () => {
    expect(
      animeIdentityTitles({
        ...baseAnime,
        titleEnglish: "Hunter x Hunter",
        synonymsJson: "not-json",
      }),
    ).toEqual(["Hunter x Hunter", "HUNTER×HUNTER"]);
  });
});
