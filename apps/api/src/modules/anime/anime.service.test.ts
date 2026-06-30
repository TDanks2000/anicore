import { describe, expect, test } from "bun:test";

import { formatAnime } from "./anime.service";
import type { Anime } from "@anicore/db/schema";

describe("formatAnime", () => {
  test("exposes genres and synonyms arrays instead of json storage fields", () => {
    const row = {
      id: 1,
      slug: "cowboy-bebop",
      titleRomaji: "Cowboy Bebop",
      titleEnglish: null,
      titleNative: null,
      titleUserPreferred: null,
      description: null,
      format: null,
      status: null,
      source: null,
      season: null,
      seasonYear: null,
      startDate: null,
      endDate: null,
      episodeCount: null,
      durationMinutes: null,
      countryOfOrigin: null,
      isAdult: false,
      genresJson: '["Action","Sci-Fi"]',
      synonymsJson: '["CB"]',
      averageScore: null,
      meanScore: null,
      popularity: null,
      favourites: null,
      trending: null,
      coverImage: null,
      coverImageColor: null,
      bannerImage: null,
      trailerVideoId: null,
      trailerSite: null,
      trailerThumbnail: null,
      nextEpisodeNumber: null,
      nextEpisodeAirsAt: null,
      hashtag: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    } satisfies Anime;

    expect(formatAnime(row)).toMatchObject({
      id: 1,
      slug: "cowboy-bebop",
      genres: ["Action", "Sci-Fi"],
      synonyms: ["CB"],
    });
    expect("genresJson" in formatAnime(row)).toBe(false);
    expect("synonymsJson" in formatAnime(row)).toBe(false);
  });
});
