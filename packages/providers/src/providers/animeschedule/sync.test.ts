import { describe, expect, test } from "bun:test";

import type { AnimeScheduleEntry } from "./client";
import {
  animeScheduleCrossMappings,
  animeScheduleDubEvidenceAction,
  animeScheduleTrackEvidence,
  isAnimeScheduleEntryForAnilist,
  selectVerifiedAnimeScheduleEntry,
} from "./sync";

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
      isAnimeScheduleEntryForAnilist(entry("https://anilist.co/anime/151807/Example/"), "151807"),
    ).toBe(true);

    expect(
      isAnimeScheduleEntryForAnilist(entry("https://anilist.co/anime/999999/Other/"), "151807"),
    ).toBe(false);
  });

  test("rejects entries without an AniList link", () => {
    expect(isAnimeScheduleEntryForAnilist(entry(undefined), "151807")).toBe(false);
    expect(isAnimeScheduleEntryForAnilist(null, "151807")).toBe(false);
  });
});

describe("AnimeSchedule dub evidence lifecycle", () => {
  test("a premiere proves existence without proving all episodes", () => {
    const value = entry("https://anilist.co/anime/151807/Example/");
    expect(animeScheduleDubEvidenceAction(value)).toBe("available");
    expect(animeScheduleTrackEvidence(value, "audio", Date.parse("2026-10-01"))).toEqual({
      exists: true,
      availableEpisodes: [1],
    });
  });

  test("missing schedule data withdraws evidence instead of asserting absence", () => {
    const value = entry("https://anilist.co/anime/151807/Example/");
    value.dubPremier = "0001-01-01T00:00:00Z";
    expect(animeScheduleDubEvidenceAction(value)).toBe("clear");
  });

  test("an ongoing original broadcast does not erase an already aired dub premiere", () => {
    const value = entry("https://anilist.co/anime/151807/Example/");
    value.status = "Ongoing";
    expect(animeScheduleDubEvidenceAction(value)).toBe("available");
  });

  test("Cowboy Bebop's time markers prove English tracks despite zero premieres", () => {
    const value = entry("anilist.co/anime/1");
    value.premier = "1998-04-02T16:00:00Z";
    value.dubPremier = value.subPremier = "0001-01-01T00:00:00Z";
    value.jpnTime = "2020-06-14T16:00:00Z";
    value.dubTime = value.subTime = "2023-03-18T16:01:00Z";
    for (const mediaType of ["audio", "subtitle"] as const)
      expect(animeScheduleTrackEvidence(value, mediaType)).toEqual({
        exists: true,
        availableEpisodes: [],
      });
  });

  test("future premiere and override do not establish released audio", () => {
    const value = entry("anilist.co/anime/1");
    value.dubTime = "2023-03-18T16:01:00Z";
    value.dubEpisodeOverride = {
      overrideDate: "2026-01-02T00:00:00Z",
      overrideEpisode: 12,
      episodesAired: 11,
    };
    expect(animeScheduleTrackEvidence(value, "audio", Date.parse("2025-12-31"))).toEqual({
      exists: false,
      availableEpisodes: [],
    });
  });

  test("an override records exactly its batch, never preceding episodes", () => {
    const value = entry("anilist.co/anime/1");
    value.dubPremier = "0001-01-01T00:00:00Z";
    value.dubEpisodeOverride = {
      overrideDate: "2026-01-02T00:00:00Z",
      overrideEpisode: 12,
      episodesAired: 5,
    };
    expect(animeScheduleTrackEvidence(value, "audio", Date.parse("2026-02-01"))).toEqual({
      exists: true,
      availableEpisodes: [7, 8, 9, 10, 11, 12],
    });
  });

  test("refuses multiple routes claiming the same AniList identity", () => {
    const first = entry("anilist.co/anime/1");
    expect(() =>
      selectVerifiedAnimeScheduleEntry([first, { ...first, route: "another" }], "1"),
    ).toThrow("Multiple AnimeSchedule routes");
    expect(selectVerifiedAnimeScheduleEntry([first, entry("anilist.co/anime/2")], "1")).toEqual(
      first,
    );
  });
});

describe("AnimeSchedule cross-references", () => {
  function withWebsites(websites: NonNullable<AnimeScheduleEntry["websites"]>): AnimeScheduleEntry {
    return { ...entry("1"), websites };
  }

  test("extracts numeric Kitsu and MAL ids", () => {
    const { mappings, skippedKitsuSlug } = animeScheduleCrossMappings(
      withWebsites({
        aniList: "anilist.co/anime/100813",
        kitsu: "kitsu.io/anime/14144",
        mal: "myanimelist.net/anime/36522",
      }),
    );

    expect(skippedKitsuSlug).toBeNull();
    expect(mappings).toEqual([
      {
        provider: "mal",
        providerId: "36522",
        providerUrl: "https://myanimelist.net/anime/36522",
      },
      {
        provider: "kitsu",
        providerId: "14144",
        providerSlug: null,
        providerUrl: "https://kitsu.io/anime/14144",
      },
    ]);
  });

  test("parses ids from urls that carry a trailing title segment", () => {
    const { mappings } = animeScheduleCrossMappings(
      withWebsites({
        mal: "myanimelist.net/anime/37029/Hoozuki_no_Reitetsu_2nd_Season__Sono_Ni",
      }),
    );

    expect(mappings).toEqual([
      {
        provider: "mal",
        providerId: "37029",
        providerUrl: "https://myanimelist.net/anime/37029",
      },
    ]);
  });

  test("reports a slug-only Kitsu reference instead of inventing a provider id", () => {
    const { mappings, skippedKitsuSlug } = animeScheduleCrossMappings(
      withWebsites({ kitsu: "kitsu.io/anime/hoozuki-no-reitetsu-2nd-season-sono-ni" }),
    );

    expect(mappings).toEqual([]);
    expect(skippedKitsuSlug).toBe("hoozuki-no-reitetsu-2nd-season-sono-ni");
  });

  test("yields nothing when the entry publishes no cross-references", () => {
    const { mappings, skippedKitsuSlug } = animeScheduleCrossMappings(entry("1"));
    expect(mappings).toEqual([]);
    expect(skippedKitsuSlug).toBeNull();
  });
});
