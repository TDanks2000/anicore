import { describe, expect, test } from "bun:test";
import {
  type AlignmentTarget,
  alignCrunchyroll,
  type CrunchyrollCatalogue,
  crunchyrollLanguage,
  episodeTitlesAgree,
  isPlaceholderTitle,
  parseCrunchyrollLink,
  seasonBySiblingOrder,
  seasonPlausiblyThisAnime,
  titlesContradictAlignment,
} from "./alignment";
import type { CrunchyrollEpisode } from "./client";
import catalogues from "./fixtures/catalogues.json";

// Live Crunchyroll catalogue payloads (GB region, 2026-10-03), parsed by the client.
const bebop = catalogues.GYVNXMVP6 as unknown as CrunchyrollCatalogue;
const attackOnTitan = catalogues.GR751KNZY as unknown as CrunchyrollCatalogue;
const frieren = catalogues.GG5H5XQX4 as unknown as CrunchyrollCatalogue;

function target(overrides: Partial<AlignmentTarget>): AlignmentTarget {
  return { status: "FINISHED", episodeCount: null, startDate: null, episodes: [], ...overrides };
}

function aligned(catalogue: CrunchyrollCatalogue, input: Partial<AlignmentTarget>) {
  const result = alignCrunchyroll(catalogue, target(input));
  if (!result.ok) throw new Error(result.reason);
  const { tier, firstNumber, episodes } = result.alignment;
  return {
    tier,
    firstNumber,
    count: episodes.length,
    first: episodes[0]?.episode.title,
    last: episodes.at(-1)?.episode.title,
  };
}

describe("Crunchyroll alignment against real catalogues", () => {
  test("Cowboy Bebop fits its only season despite TV Tokyo premiere dates", () => {
    // AniList starts Bebop on 1998-04-03, the TV Tokyo date Crunchyroll gives
    // episode 2; episode 1 carries the WOWOW date. The season fit wins only
    // because the date anchor at episode 2 cannot cover 26 episodes.
    expect(aligned(bebop, { episodeCount: 26, startDate: "1998-04-03" })).toEqual({
      tier: 3,
      firstNumber: 1,
      count: 26,
      first: "Asteroid Blues",
      last: "The Real Folk Blues (part 2)",
    });
  });

  test("every Attack on Titan TV entry lands on its own slice of the series", () => {
    const entries: Array<[number, string, number, string]> = [
      [25, "2013-04-07", 1, "The Wall - Raid on Stohess District (3)"],
      [12, "2017-04-01", 26, "Scream"],
      [12, "2018-07-23", 38, "Night of the Battle to Retake the Wall"],
      [10, "2019-04-29", 50, "The Other Side of the Wall"],
      [16, "2020-12-07", 60, "Above and Below"],
      [12, "2022-01-10", 76, "The Dawn of Humanity"],
    ];
    for (const [episodeCount, startDate, firstNumber, last] of entries) {
      const result = aligned(attackOnTitan, { episodeCount, startDate });
      expect({ firstNumber: result.firstNumber, count: result.count, last: result.last }).toEqual({
        firstNumber,
        count: episodeCount,
        last,
      });
    }
  });

  test("recaps, specials and PVs never occupy an episode number", () => {
    const season1 = aligned(attackOnTitan, { episodeCount: 25, startDate: "2013-04-07" });
    expect(season1.tier).toBe(1);
    const result = alignCrunchyroll(
      attackOnTitan,
      target({ episodeCount: 25, startDate: "2013-04-07" }),
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.alignment.episodes.map((pair) => pair.episode.episode)).not.toContain("13.5");
    expect(result.alignment.episodes[13]?.episode.title).toStartWith("Still Can't See");
  });

  test("a sequel season restarting at episode 1 is told apart by its premiere", () => {
    expect(aligned(frieren, { episodeCount: 28, startDate: "2023-09-29" })).toMatchObject({
      tier: 1,
      count: 28,
    });
    expect(aligned(frieren, { episodeCount: 10, startDate: "2026-01-16" })).toMatchObject({
      tier: 1,
      count: 10,
      first: "Shall We Go, Then?",
    });
  });

  test("a premiere date preceded by a later-dated episode is not a split cour", () => {
    // 24 episodes starting on episode 2's TV Tokyo date would shift Bebop by one.
    expect(
      alignCrunchyroll(bebop, target({ episodeCount: 24, startDate: "1998-04-03" })),
    ).toMatchObject({ ok: false });
  });

  test("bulk upload dates neither anchor nor veto a linked season", () => {
    // Last Exile's back catalogue is dated 2017-05-18 throughout; it aired in 2003.
    const uploaded: CrunchyrollCatalogue = {
      ...bebop,
      seasons: bebop.seasons.map((season) => ({
        ...season,
        episodes: season.episodes.map((episode) => ({ ...episode, airDate: "2017-05-18" })),
      })),
    };
    expect(aligned(uploaded, { episodeCount: 26, startDate: "1998-04-03" })).toMatchObject({
      tier: 3,
      count: 26,
    });
    expect(
      alignCrunchyroll(uploaded, target({ episodeCount: 26, startDate: "2017-05-18" }), {
        requireDateAnchor: true,
      }),
    ).toMatchObject({ ok: false });
  });

  test("a single special with no numbered episode abstains", () => {
    expect(
      alignCrunchyroll(attackOnTitan, target({ episodeCount: 1, startDate: "2023-03-04" })),
    ).toMatchObject({ ok: false });
  });

  test("an unanchored airing entry and an unknown length abstain", () => {
    expect(
      alignCrunchyroll(frieren, target({ status: "RELEASING", episodeCount: 10 })),
    ).toMatchObject({ ok: false });
    expect(alignCrunchyroll(frieren, target({ startDate: "2023-09-29" }))).toEqual({
      ok: false,
      reason: "episode count unknown",
    });
  });

  test("search-discovered series must be anchored on the premiere date", () => {
    expect(
      alignCrunchyroll(bebop, target({ episodeCount: 26, startDate: "1998-04-03" }), {
        requireDateAnchor: true,
      }),
    ).toMatchObject({ ok: false });
  });

  test("a finished entry missing an episode on Crunchyroll abstains", () => {
    const trimmed: CrunchyrollCatalogue = {
      ...bebop,
      seasons: bebop.seasons.map((season) => ({
        ...season,
        episodes: season.episodes.filter((episode) => episode.episode !== "13"),
      })),
    };
    expect(
      alignCrunchyroll(trimmed, target({ episodeCount: 26, startDate: "1998-04-03" })),
    ).toMatchObject({ ok: false });
  });

  test("two seasons fitting equally well is ambiguous", () => {
    const twin: CrunchyrollCatalogue = {
      ...bebop,
      seasons: [
        ...bebop.seasons,
        ...bebop.seasons.map(({ season, episodes }) => ({
          season: { ...season, id: "GTWINSEASON", sequenceNumber: 2 },
          episodes: episodes.map((episode) => ({
            ...episode,
            id: `${episode.id}X`,
            seasonId: "GTWINSEASON",
          })),
        })),
      ],
    };
    expect(alignCrunchyroll(twin, target({ episodeCount: 26, startDate: "1998-04-03" }))).toEqual({
      ok: false,
      reason: "ambiguous tier 3 alignment",
    });
  });

  test("episode titles veto an alignment shifted by one", () => {
    const titles = bebop.seasons[0]!.episodes.map((episode) => ({
      number: episode.episodeNumber! - 1,
      titles: [episode.title!],
    }));
    expect(
      alignCrunchyroll(
        bebop,
        target({ episodeCount: 26, startDate: "1998-04-03", episodes: titles }),
      ),
    ).toMatchObject({ ok: false });
    const matching = titles.map((episode) => ({ ...episode, number: episode.number + 1 }));
    expect(
      alignCrunchyroll(
        bebop,
        target({ episodeCount: 26, startDate: "1998-04-03", episodes: matching }),
      ),
    ).toMatchObject({ ok: true });
  });
});

describe("Crunchyroll series-level fallback", () => {
  const tv = { ...target({ episodeCount: 24, startDate: "1998-04-03" }), format: "TV" };

  test("a near-sized season from the same years can stand for the anime", () => {
    expect(seasonPlausiblyThisAnime(bebop, tv)).toBe(true);
  });

  test("films, sequels and differently sized works linking the parent show cannot", () => {
    expect(seasonPlausiblyThisAnime(bebop, { ...tv, format: "MOVIE", episodeCount: 1 })).toBe(
      false,
    );
    expect(seasonPlausiblyThisAnime(bebop, { ...tv, episodeCount: 12 })).toBe(false);
    expect(seasonPlausiblyThisAnime(bebop, { ...tv, startDate: "2005-01-01" })).toBe(false);
    expect(seasonPlausiblyThisAnime(attackOnTitan, { ...tv, episodeCount: 25 })).toBe(false);
  });
});

describe("Crunchyroll title and link helpers", () => {
  test("episode titles agree across translations but not across episodes", () => {
    expect(episodeTitlesAgree("That Day", "That Day - The Fall of Zhiganshina (2)")).toBe(true);
    expect(episodeTitlesAgree("Asteroid Blues", "asteroid blues")).toBe(true);
    expect(episodeTitlesAgree("Asteroid Blues", "Stray Dog Strut")).toBe(false);
  });

  test("numbered placeholder titles are neither titles nor evidence", () => {
    expect(["Episode 1", "episode 12.5", "Ep. 3", "#4", null].every(isPlaceholderTitle)).toBe(true);
    expect(isPlaceholderTitle("Episode 1: Asteroid Blues")).toBe(false);
    // Fruits Basket (2001) is titled "Episode N" throughout on Crunchyroll.
    const placeholders: CrunchyrollCatalogue = {
      ...bebop,
      seasons: bebop.seasons.map((season) => ({
        ...season,
        episodes: season.episodes.map((episode) => ({
          ...episode,
          title: `Episode ${episode.episode}`,
        })),
      })),
    };
    const realTitles = bebop.seasons[0]!.episodes.map((episode) => ({
      number: episode.episodeNumber!,
      titles: [episode.title!],
    }));
    expect(
      alignCrunchyroll(
        placeholders,
        target({ episodeCount: 26, startDate: "1998-04-03", episodes: realTitles }),
      ),
    ).toMatchObject({ ok: true });
  });

  test("too few comparable titles never veto", () => {
    const pair = (localNumber: number, title: string) => ({
      localNumber,
      episode: { title } as CrunchyrollEpisode,
    });
    expect(titlesContradictAlignment([pair(1, "A"), pair(2, "B")], new Map([[1, ["Z"]]]))).toBe(
      false,
    );
  });

  test("reads modern ids and legacy slugs, and rejects other destinations", () => {
    expect(
      parseCrunchyrollLink("https://www.crunchyroll.com/series/GYVNXMVP6/cowboy-bebop"),
    ).toEqual({
      seriesId: "GYVNXMVP6",
    });
    expect(parseCrunchyrollLink("https://www.crunchyroll.com/en-gb/series/GR751KNZY")).toEqual({
      seriesId: "GR751KNZY",
    });
    expect(parseCrunchyrollLink("http://www.crunchyroll.com/cowboy-bebop")).toEqual({
      slug: "cowboy-bebop",
    });
    expect(parseCrunchyrollLink("https://crunchyroll.com/fr/naruto")).toEqual({ slug: "naruto" });
    for (const url of [
      "https://www.crunchyroll.com/watch/G14U4XX4N/asteroid-blues",
      "https://www.crunchyroll.com/news",
      "https://crunchyroll.com.evil.example/cowboy-bebop",
      "https://user@www.crunchyroll.com/cowboy-bebop",
      "https://www.crunchyroll.com/series/not-an-id",
      "not a url",
    ])
      expect(parseCrunchyrollLink(url)).toBeNull();
  });

  test("locales fold to AniCore's base language codes", () => {
    expect(
      ["en-US", "es-419", "pt-BR", "ja-JP", "zh-HK", "bogus!"].map(crunchyrollLanguage),
    ).toEqual(["en", "es", "pt", "ja", "zh", null]);
  });
});

/** Bebop cut into two 13-episode seasons dated by upload, like Vandread. */
function twoCourCatalogue(): CrunchyrollCatalogue {
  const [{ season, episodes }] = bebop.seasons;
  const split = (id: string, sequenceNumber: number, from: number, to: number) => ({
    season: { ...season!, id, sequenceNumber },
    episodes: episodes
      .filter((episode) => episode.episodeNumber! >= from && episode.episodeNumber! <= to)
      .map((episode) => ({ ...episode, seasonId: id, airDate: "2017-05-18" })),
  });
  return { ...bebop, seasons: [split("GCOURONE", 1, 1, 13), split("GCOURTWO", 2, 14, 26)] };
}

describe("Crunchyroll seasons told apart by linked siblings", () => {
  const siblings = [
    { animeId: 2, episodeCount: 13, startDate: "2001-10-05" },
    { animeId: 1, episodeCount: 13, startDate: "2000-10-03" },
  ];

  test("two equal undated seasons are ambiguous on their own", () => {
    expect(
      alignCrunchyroll(twoCourCatalogue(), target({ episodeCount: 13, startDate: "2001-10-05" })),
    ).toEqual({ ok: false, reason: "ambiguous tier 3 alignment" });
  });

  test("each anime takes the season at its premiere-ordered position", () => {
    const second = seasonBySiblingOrder(twoCourCatalogue(), siblings, 2);
    expect(second?.seasons.map((entry) => entry.season.id)).toEqual(["GCOURTWO"]);
    const result = alignCrunchyroll(second!, target({ episodeCount: 13, startDate: "2001-10-05" }));
    if (!result.ok) throw new Error(result.reason);
    expect(result.alignment.firstNumber).toBe(14);
    expect(seasonBySiblingOrder(twoCourCatalogue(), siblings, 1)?.seasons[0]?.season.id).toBe(
      "GCOURONE",
    );
  });

  test("any mismatch in count, order or dates abstains", () => {
    const catalogue = twoCourCatalogue();
    expect(seasonBySiblingOrder(catalogue, siblings.slice(0, 1), 2)).toBeNull();
    expect(
      seasonBySiblingOrder(catalogue, [siblings[0]!, { ...siblings[1]!, episodeCount: 12 }], 2),
    ).toBeNull();
    expect(
      seasonBySiblingOrder(catalogue, [siblings[0]!, { ...siblings[1]!, startDate: null }], 2),
    ).toBeNull();
    expect(
      seasonBySiblingOrder(
        catalogue,
        [...siblings, { animeId: 3, episodeCount: 1, startDate: "2003-01-01" }],
        2,
      ),
    ).toBeNull();
    expect(seasonBySiblingOrder(catalogue, siblings, 99)).toBeNull();
  });
});
