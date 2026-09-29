import { describe, expect, test } from "bun:test";

import type { AnimeScheduleEntry } from "./client";
import {
  animeScheduleCrossMappings,
  animeScheduleDubEvidenceAction,
  isAnimeScheduleEntryForAnilist,
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
  test("marks every canonical episode available only for a finished dub", () => {
    const value = entry("https://anilist.co/anime/151807/Example/");
    expect(animeScheduleDubEvidenceAction(value)).toBe("available");
  });

  test("replaces stale positive evidence with missing when no dub premiere exists", () => {
    const value = entry("https://anilist.co/anime/151807/Example/");
    value.dubPremier = "0001-01-01T00:00:00Z";
    expect(animeScheduleDubEvidenceAction(value)).toBe("missing");
  });

  test("withdraws all-available evidence while a known dub is still ongoing", () => {
    const value = entry("https://anilist.co/anime/151807/Example/");
    value.status = "Ongoing";
    expect(animeScheduleDubEvidenceAction(value)).toBe("clear");
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
