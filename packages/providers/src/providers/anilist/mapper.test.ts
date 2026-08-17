import { describe, expect, test } from "bun:test";

import { mapAnilistAnime } from "./mapper";

type MediaInput = Parameters<typeof mapAnilistAnime>[0];

function media(overrides: Record<string, unknown> = {}): MediaInput {
  return {
    id: 1,
    idMal: 5,
    title: {
      romaji: "Cowboy Bebop",
      english: "Cowboy Bebop",
      native: "カウボーイビバップ",
      userPreferred: "Cowboy Bebop",
    },
    ...overrides,
  } as unknown as MediaInput;
}

describe("AniList mapper cross-provider identity", () => {
  test("emits AniList idMal as an authoritative MAL mapping", () => {
    expect(mapAnilistAnime(media()).authoritativeMappings).toEqual([
      {
        provider: "mal",
        providerId: "5",
        providerUrl: "https://myanimelist.net/anime/5",
      },
    ]);
  });

  test("does not invent a MAL mapping when AniList has no idMal", () => {
    expect(
      mapAnilistAnime(media({ idMal: null })).authoritativeMappings,
    ).toEqual([]);
  });
});
