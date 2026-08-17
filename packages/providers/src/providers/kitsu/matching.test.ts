import { describe, expect, test } from "bun:test";

import type { KitsuSearchNode } from "./client";
import {
  isAuthoritativeAnilistMatch,
  scoreKitsuCandidate,
  selectKitsuMatch,
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
      pageInfo: { hasNextPage: false },
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

describe("Kitsu authoritative matching", () => {
  test("prioritizes an authoritative AniList mapping", () => {
    const node = candidate("8");

    expect(isAuthoritativeAnilistMatch(node, "8")).toBe(true);
    expect(scoreKitsuCandidate(node, hints)).toBe(1_000);
  });

  test("finds the target AniList mapping even when it is not first", () => {
    const node = candidate("1123");
    node.mappings = {
      nodes: [
        { externalId: "1123", externalSite: "ANILIST_ANIME" },
        { externalId: "8", externalSite: "ANILIST_ANIME" },
      ],
      pageInfo: { hasNextPage: false },
    };

    expect(isAuthoritativeAnilistMatch(node, "8")).toBe(true);
    expect(scoreKitsuCandidate(node, hints)).toBe(1_000);
  });

  test("rejects a candidate mapped to a different AniList anime", () => {
    const node = candidate("1123");

    expect(isAuthoritativeAnilistMatch(node, "8")).toBe(false);
    expect(scoreKitsuCandidate(node, hints)).toBe(-1);
  });

  test("does not fuzzy-match when the authoritative mapping page is incomplete", () => {
    const node = candidate("8");
    node.mappings = {
      nodes: [],
      pageInfo: { hasNextPage: true },
    };

    expect(scoreKitsuCandidate(node, hints)).toBe(-1);
  });
});

describe("Kitsu fuzzy matching", () => {
  test("requires meaningful title agreement even when metadata lines up", () => {
    const node = candidate("8");
    node.mappings = { nodes: [], pageInfo: { hasNextPage: false } };
    node.titles = {
      romanized: "Completely Different Show",
      translated: "Unrelated Anime",
      original: null,
      localized: {},
      alternatives: [],
    };

    expect(scoreKitsuCandidate(node, hints)).toBe(-1);
  });

  test("rejects ambiguous fuzzy candidates instead of choosing search order", () => {
    const first = candidate("8");
    const second = candidate("8");
    first.id = "first";
    second.id = "second";

    expect(
      selectKitsuMatch([
        { node: first, score: 82 },
        { node: second, score: 77 },
      ]),
    ).toBeNull();
  });

  test("accepts a clearly separated candidate", () => {
    const first = candidate("8");
    const second = candidate("8");
    first.id = "first";
    second.id = "second";

    expect(
      selectKitsuMatch([
        { node: first, score: 82 },
        { node: second, score: 60 },
      ]),
    ).toBe(first);
  });
});
