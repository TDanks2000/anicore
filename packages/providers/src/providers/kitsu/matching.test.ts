import { describe, expect, test } from "bun:test";

import type { KitsuSearchNode } from "./client";
import {
  hasKitsuStructuralConflict,
  isAuthoritativeAnilistMatch,
  kitsuSearchTitles,
  scoreKitsuCandidate,
  scoreKitsuCandidates,
  selectKitsuMatch,
  sharedCandidateTitles,
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
  format: "TV",
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

  test("keeps a direct AniList mapping authoritative even when provider metadata differs", () => {
    const node = candidate("8");
    node.startDate = "2010-01-01";
    node.episodeCount = 1;

    expect(hasKitsuStructuralConflict(node, hints)).toBe(true);
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

describe("Kitsu title discovery", () => {
  test("uses native titles and bounded unique synonyms only as fallbacks", () => {
    const titles = kitsuSearchTitles({
      ...hints,
      titleEnglish: "Bouken Ou Beet",
      titleNative: "冒険王ビィト",
      synonyms: [
        "Beet the Vandel Buster",
        "Bouken Ou Beet",
        "Adventure King Beet",
        "Boken Ou Beet",
        "Beet",
        "Extra synonym beyond cap",
      ],
    });

    expect(titles.primary).toEqual(["Bouken Ou Beet"]);
    // "Boken Ou Beet" is absent because long-vowel folding now normalizes it
    // onto the same key as "Bouken Ou Beet" — they are the same title in two
    // romanizations, so spending a bounded fallback slot on both is wasteful.
    // The freed slot goes to the next distinct synonym instead.
    expect(titles.fallback).toEqual([
      "冒険王ビィト",
      "Beet the Vandel Buster",
      "Adventure King Beet",
      "Beet",
    ]);
  });

  test("lets an AniList synonym contribute to fuzzy title evidence", () => {
    const node = candidate("8");
    node.mappings = { nodes: [], pageInfo: { hasNextPage: false } };

    expect(
      scoreKitsuCandidate(node, {
        ...hints,
        titleRomaji: "Unhelpful Primary Title",
        titleEnglish: null,
        synonyms: ["Beet the Vandel Buster"],
      }),
    ).toBeGreaterThanOrEqual(45);
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

  test("rejects an exact-title candidate from a clearly different year", () => {
    const node = candidate("8");
    node.mappings = { nodes: [], pageInfo: { hasNextPage: false } };
    node.startDate = "2010-01-01";

    expect(hasKitsuStructuralConflict(node, hints)).toBe(true);
    expect(scoreKitsuCandidate(node, hints)).toBe(-1);
  });

  test("rejects an exact-title candidate with a grossly incompatible episode count", () => {
    const node = candidate("8");
    node.mappings = { nodes: [], pageInfo: { hasNextPage: false } };
    node.episodeCount = 1;

    expect(hasKitsuStructuralConflict(node, hints)).toBe(true);
    expect(scoreKitsuCandidate(node, hints)).toBe(-1);
  });

  test("tolerates missing structural metadata instead of treating it as conflict", () => {
    const node = candidate("8");
    node.mappings = { nodes: [], pageInfo: { hasNextPage: false } };
    node.startDate = null;
    node.episodeCount = null;

    expect(hasKitsuStructuralConflict(node, hints)).toBe(false);
  });

  test("rejects a movie candidate for a TV target", () => {
    const node = candidate("8");
    node.mappings = { nodes: [], pageInfo: { hasNextPage: false } };
    node.subtype = "MOVIE";

    expect(hasKitsuStructuralConflict(node, hints)).toBe(true);
    expect(scoreKitsuCandidate(node, hints)).toBe(-1);
  });

  test("rejects a TV short candidate for a movie target", () => {
    const node = candidate("8");
    node.mappings = { nodes: [], pageInfo: { hasNextPage: false } };
    node.subtype = "TV_SHORT";

    expect(hasKitsuStructuralConflict(node, { ...hints, format: " movie " })).toBe(true);
    expect(scoreKitsuCandidate(node, { ...hints, format: " movie " })).toBe(-1);
  });

  test("keeps a direct AniList mapping authoritative over a format conflict", () => {
    const node = candidate("8");
    node.subtype = "MOVIE";

    expect(hasKitsuStructuralConflict(node, hints)).toBe(true);
    expect(scoreKitsuCandidate(node, hints)).toBe(1_000);
  });

  test("tolerates missing and unrelated formats", () => {
    const node = candidate("8");
    node.mappings = { nodes: [], pageInfo: { hasNextPage: false } };
    node.subtype = "OVA";

    expect(hasKitsuStructuralConflict(node, { ...hints, format: null })).toBe(false);
    expect(hasKitsuStructuralConflict(node, { ...hints, format: "MOVIE" })).toBe(false);
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

describe("premiere-date evidence", () => {
  test("an exact start date decides between same-year franchise entries", () => {
    const withDate = (id: string, startDate: string) => {
      const node = candidate("unused");
      node.id = id;
      node.mappings = { nodes: [], pageInfo: { hasNextPage: false } };
      node.startDate = startDate;
      node.episodeCount = 1;
      node.subtype = "movie";
      node.titles = {
        romanized: "Kuroko no Basket Movie",
        translated: null,
        original: null,
        localized: {},
        alternatives: [],
      };
      return node;
    };

    const hints = {
      titleRomaji: "Kuroko no Basket Movie",
      format: "MOVIE",
      seasonYear: 2016,
      startDate: "2016-10-08",
      episodeCount: 1,
    };

    const right = scoreKitsuCandidate(withDate("a", "2016-10-08"), hints);
    const wrong = scoreKitsuCandidate(withDate("b", "2016-09-03"), hints);

    // Same title, same year, same episode count: only the date separates them,
    // and it must separate them by more than the ambiguity margin.
    expect(right - wrong).toBeGreaterThan(10);
  });

  test("a start date more than a year apart is a structural conflict", () => {
    const node = candidate("a");
    node.startDate = "2022-08-10";
    expect(
      hasKitsuStructuralConflict(node, {
        titleRomaji: "Fei Ren Zai",
        startDate: "2020-01-08",
      }),
    ).toBe(true);
  });
});

describe("episode-count disagreement", () => {
  test("an exact premiere date overrides a counting-convention difference", () => {
    const node = candidate("unused");
    node.id = "3913";
    node.mappings = { nodes: [], pageInfo: { hasNextPage: false } };
    node.subtype = "TV";
    node.startDate = "2003-04-07";
    node.episodeCount = 52;
    node.titles = {
      romanized: "Croket!",
      translated: null,
      original: null,
      localized: {},
      alternatives: [],
    };

    // AniList counts 104 segments where Kitsu counts 52 slots.
    const croket: MatchHints = {
      titleRomaji: "CROKET!",
      format: "TV",
      season: "SPRING",
      seasonYear: 2003,
      startDate: "2003-04-07",
      episodeCount: 104,
    };

    expect(hasKitsuStructuralConflict(node, croket)).toBe(false);
    expect(scoreKitsuCandidate(node, croket)).toBeGreaterThanOrEqual(45);
  });

  test("still rejects a count mismatch when the premiere dates differ", () => {
    const node = candidate("unused");
    node.id = "x";
    node.mappings = { nodes: [], pageInfo: { hasNextPage: false } };
    node.episodeCount = 1;

    expect(hasKitsuStructuralConflict(node, hints)).toBe(true);
  });
});

describe("catalogue-type agreement", () => {
  test("format agreement separates a series from its mini-anime spin-off", () => {
    const build = (id: string, subtype: string, title: string) => {
      const node = candidate("unused");
      node.id = id;
      node.mappings = { nodes: [], pageInfo: { hasNextPage: false } };
      node.subtype = subtype;
      node.startDate = "2023-10-04";
      node.episodeCount = 12;
      node.titles = {
        romanized: title,
        translated: null,
        original: null,
        localized: {},
        alternatives: [],
      };
      return node;
    };

    // Same premiere date, same episode count, near-identical titles: only the
    // catalogue type tells the series apart from its mini-anime companion.
    const series = build("47099", "TV", "Kage no Jitsuryokusha ni Naritakute! 2nd Season");
    const mini = build("48198", "ONA", "Kage no Jitsuryokusha ni Naritakute! 2nd Season Mini Anime");

    const target: MatchHints = {
      titleRomaji: "Kage no Jitsuryokusha ni Naritakute! 2nd season",
      format: "TV",
      seasonYear: 2023,
      startDate: "2023-10-04",
      episodeCount: 12,
    };

    expect(selectKitsuMatch(scoreKitsuCandidates([series, mini], target))?.id).toBe(
      "47099",
    );
  });

  test("TV_SHORT agrees with Kitsu's TV, which has no short subtype", () => {
    const node = candidate("unused");
    node.mappings = { nodes: [], pageInfo: { hasNextPage: false } };
    node.subtype = "TV";
    node.startDate = "2004-09-30";

    const asShort = scoreKitsuCandidate(node, { ...hints, format: "TV_SHORT" });
    const asUnknown = scoreKitsuCandidate(node, { ...hints, format: null });
    expect(asShort).toBeGreaterThan(asUnknown);
  });
});

describe("titles shared across candidates", () => {
  function songNode(id: string, ownTitle: string) {
    const node = candidate("unused");
    node.id = id;
    node.mappings = { nodes: [], pageInfo: { hasNextPage: false } };
    node.episodeCount = 1;
    node.titles = {
      romanized: ownTitle,
      translated: null,
      original: null,
      localized: {},
      // The umbrella programme name every entry carries.
      alternatives: ["Minna no Uta"],
    };
    return node;
  }

  test("an umbrella title carried by several candidates is not identity evidence", () => {
    const nodes = [
      songNode("11569", "Tenkousei wa Uchuujin"),
      songNode("2673", "Egao"),
      songNode("5456", "Kumo ga Haretara"),
    ];

    expect(sharedCandidateTitles(nodes).has("minna no uta")).toBe(true);

    const scored = scoreKitsuCandidates(nodes, {
      titleRomaji: "Tenkousei wa Uchuujin",
      synonyms: ["Minna no Uta"],
      episodeCount: 1,
      format: "MUSIC",
    });

    const selected = selectKitsuMatch(scored);
    // Without the discount all three tie on the umbrella title and the matcher
    // abstains; with it, only the real title carries evidence.
    expect(selected?.id).toBe("11569");
  });

  test("a primary title is identity evidence even when relatives share it", () => {
    // "Soul Link" is the series' own name and merely an alternative title on
    // its specials. Discounting it everywhere erased the correct record's only
    // evidence and made the matcher abstain on the whole franchise.
    const series = candidate("unused");
    series.id = "756";
    series.mappings = { nodes: [], pageInfo: { hasNextPage: false } };
    series.subtype = "TV";
    series.startDate = "2006-04-02";
    series.episodeCount = 12;
    series.titles = {
      romanized: "Soul Link",
      translated: "Soul Link",
      original: null,
      localized: {},
      alternatives: [],
    };

    const special = candidate("unused");
    special.id = "6154";
    special.mappings = { nodes: [], pageInfo: { hasNextPage: false } };
    special.subtype = "SPECIAL";
    special.startDate = "2006-07-21";
    special.episodeCount = 3;
    special.titles = {
      romanized: "Soul Link Picture Drama",
      translated: null,
      original: null,
      localized: {},
      alternatives: ["Soul Link"],
    };

    const soulLink: MatchHints = {
      titleRomaji: "Soul Link",
      format: "TV",
      seasonYear: 2006,
      startDate: "2006-04-02",
      episodeCount: 12,
    };

    expect(sharedCandidateTitles([series, special]).has("soul link")).toBe(false);
    expect(selectKitsuMatch(scoreKitsuCandidates([series, special], soulLink))?.id).toBe(
      "756",
    );
  });

  test("a title only one candidate carries is left alone", () => {
    const nodes = [songNode("1", "Solo Title"), songNode("2", "Other Title")];
    const shared = sharedCandidateTitles(nodes);
    expect(shared.has("solo title")).toBe(false);
    expect(shared.has("other title")).toBe(false);
  });
});
