import { describe, expect, test } from "bun:test";

import type { AnimeScheduleEntry } from "./client";
import { isAnimeScheduleEntryForAnilist } from "./sync";

function entry(aniList: string | undefined): AnimeScheduleEntry {
  return {
    id: "1",
    title: "Example",
    route: "example",
    premier: "2026-01-01T00:00:00Z",
    subPremier: "2026-01-01T00:00:00Z",
    dubPremier: "2026-01-01T00:00:00Z",
    episodes: 12,
    status: "Finished",
    episodeOverride: {
      overrideDate: "",
      overrideEpisode: 0,
      episodesAired: 0,
    },
    subEpisodeOverride: {
      overrideDate: "",
      overrideEpisode: 0,
      episodesAired: 0,
    },
    dubEpisodeOverride: {
      overrideDate: "",
      overrideEpisode: 0,
      episodesAired: 0,
    },
    websites: aniList ? { aniList } : undefined,
  };
}

describe("AnimeSchedule mapping verification", () => {
  test("accepts only entries linked to the expected AniList anime", () => {
    expect(
      isAnimeScheduleEntryForAnilist(
        entry("https://anilist.co/anime/151807/Example/"),
        "151807",
      ),
    ).toBe(true);

    expect(
      isAnimeScheduleEntryForAnilist(
        entry("https://anilist.co/anime/999999/Other/"),
        "151807",
      ),
    ).toBe(false);
  });

  test("rejects entries without an AniList link", () => {
    expect(isAnimeScheduleEntryForAnilist(entry(undefined), "151807")).toBe(false);
    expect(isAnimeScheduleEntryForAnilist(null, "151807")).toBe(false);
  });
});
