import { describe, expect, test } from "bun:test";

import type { KitsuSearchNode } from "./client";
import {
  isAuthoritativeAnilistMatch,
  scoreKitsuCandidate,
  type MatchHints,
} from "./matching";

function candidate(anilistId: string): KitsuSearchNode {
  return {
    id: "5",
    slug: "beet-the-vandel-buster",
    season: "FALL",
    startDate: "2004-09-30",
    endDate: "2005-09-29",
    subtype: "TV",
    status: "FINISHED",
    episodeCount: 52,
    episodeLength: 24,
    averageRating: 60,
    userCount: 100,
    userCountRank: null,
    averageRatingRank: null,
    ageRating: null,
    titles: {
      romanized: "Beet the Vandel Buster",
      translated: "Beet the Vandel Buster",
      original: null,
      localized: {},
      alternatives: ["Bouken Ou Beet"],
    },
    mappings: {
      nodes: [{ externalId: anilistId, externalSite: "ANILIST_ANIME" }],
    },
    posterImage: null,
    bannerImage: null,
  };
}

const hints: MatchHints = {
  anilistId: "8",
  titleRomaji: "Bouken Ou Beet",
  titleEnglish: "Beet the Vandel Buster",
  season: "FALL",
  seasonYear: 2004,
  episodeCount: 52,
};

describe("Kitsu matching", () => {
  test("prioritizes an authoritative AniList mapping", () => {
    const node = candidate("8");

    expect(isAuthoritativeAnilistMatch(node, "8")).toBe(true);
    expect(scoreKitsuCandidate(node, hints)).toBe(1_000);
  });

  test("rejects a candidate mapped to a different AniList anime", () => {
    const node = candidate("1123");

    expect(isAuthoritativeAnilistMatch(node, "8")).toBe(false);
    expect(scoreKitsuCandidate(node, hints)).toBe(-1);
  });
});
