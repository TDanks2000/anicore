import { describe, expect, test } from "bun:test";

import type { MappedEpisode } from "./mapper";
import { limitKitsuEpisodesToCanonicalCount } from "./sync";

function episode(number: number): MappedEpisode {
  return {
    number,
    title: `Episode ${number}`,
    titleRomaji: null,
    titleEnglish: null,
    description: null,
    airDate: null,
    lengthMinutes: null,
    thumbnail: null,
    kitsuId: `kitsu-${number}`,
    providerId: `kitsu-${number}`,
    providerEpisodeNumber: String(number),
  };
}

describe("Kitsu canonical episode count", () => {
  test("drops provider extras beyond AniList's known episode count", () => {
    expect(
      limitKitsuEpisodesToCanonicalCount(
        [episode(1), episode(2), episode(3), episode(13)],
        12,
      ).map((item) => item.number),
    ).toEqual([1, 2, 3]);
  });

  test("does not cap ongoing anime when AniList has no final count", () => {
    const mapped = [episode(1), episode(13)];
    expect(limitKitsuEpisodesToCanonicalCount(mapped, null)).toEqual(mapped);
  });
});
