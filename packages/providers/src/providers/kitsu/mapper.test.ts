import { describe, expect, test } from "bun:test";

import type { KitsuEpisodeNode, KitsuSearchNode } from "./client";
import { mapKitsuAnime, mapKitsuEpisodes } from "./mapper";

describe("Kitsu mapper", () => {
  test("maps anime when optional title fields are sparse", () => {
    const node: KitsuSearchNode = {
      id: "1",
      slug: "cowboy-bebop",
      season: null,
      startDate: "1998-04-03",
      endDate: "1999-04-24",
      subtype: "TV",
      status: "FINISHED",
      episodeCount: 26,
      episodeLength: 24,
      averageRating: 82.4,
      userCount: 1000,
      userCountRank: null,
      averageRatingRank: null,
      ageRating: null,
      titles: {
        romanized: "Cowboy Bebop",
        translated: "Cowboy Bebop",
        original: "Cowboy Bebop Native",
        localized: { en: "Cowboy Bebop" },
        alternatives: [],
      },
      posterImage: null,
      bannerImage: null,
    };

    expect(mapKitsuAnime(node)).toMatchObject({
      provider: "kitsu",
      providerId: "1",
      titleRomaji: "Cowboy Bebop",
      titleEnglish: "Cowboy Bebop",
      titleNative: "Cowboy Bebop Native",
      titleUserPreferred: "Cowboy Bebop",
      seasonYear: 1998,
      endDate: "1999-04-24",
      status: "FINISHED",
    });
  });

  test("maps episodes without clobbering missing titles into bogus strings", () => {
    const nodes: KitsuEpisodeNode[] = [
      {
        id: "ep-1",
        number: 1,
        releasedAt: "1998-04-03T00:00:00.000Z",
        length: 24,
        createdAt: "1998-04-01T00:00:00.000Z",
        titles: {
          romanized: "Asteroid Blues",
          translated: null,
          original: null,
          localized: {},
          alternatives: [],
        },
        description: { en: "The first episode." },
        thumbnail: { original: { url: "https://example.com/ep-1.jpg" } },
      },
      {
        id: "bad-episode",
        number: null,
        releasedAt: null,
        length: null,
        createdAt: null,
        titles: {
          romanized: "Skipped",
          translated: null,
          original: null,
          localized: null,
          alternatives: null,
        },
        description: null,
        thumbnail: null,
      },
    ];

    expect(mapKitsuEpisodes(nodes)).toEqual([
      {
        number: 1,
        title: "Asteroid Blues",
        titleRomaji: "Asteroid Blues",
        titleEnglish: null,
        description: "The first episode.",
        airDate: "1998-04-03",
        lengthMinutes: 24,
        thumbnail: "https://example.com/ep-1.jpg",
        kitsuId: "ep-1",
        providerId: "ep-1",
        providerEpisodeNumber: "1",
      },
    ]);
  });
});
