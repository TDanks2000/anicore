import { describe, expect, test } from "bun:test";
import type { EpisodeLanguageStatusRow } from "./anime-api";
import { inspectCoverage } from "./coverage-inspector";

function row(
  number: number,
  status = "available",
  provider = "crunchyroll",
  confidence = 95,
): EpisodeLanguageStatusRow {
  return {
    id: number,
    animeId: 1,
    episodeNumber: number,
    languageCode: "en",
    mediaType: "audio",
    status,
    provider,
    confidence,
    checkedAt: "",
    createdAt: "",
    updatedAt: "",
  };
}
const episodes = [
  { number: 1, kind: "normal" },
  { number: 2, kind: "normal" },
  { number: 3, kind: "special" },
];

describe("coverage inspector", () => {
  test("excludes specials and distinguishes unrecorded from unknown", () => {
    expect(inspectCoverage(episodes, [row(1), row(3)], "en", "audio", 4)).toMatchObject({
      recorded: 2,
      available: 1,
      unknown: 1,
      missing: 0,
      unrecorded: 2,
      complete: false,
    });
  });
  test("requires a complete expected catalogue and fully available tracks", () => {
    expect(inspectCoverage(episodes, [row(1), row(2)], "en", "audio", 2).complete).toBe(true);
    expect(inspectCoverage(episodes, [row(1), row(2)], "en", "audio", null).complete).toBe(false);
    expect(inspectCoverage(episodes, [row(1), row(2)], "en", "audio", 3).complete).toBe(false);
    expect(inspectCoverage(episodes, [row(1), row(2, "partial")], "en", "audio", 2)).toMatchObject({
      available: 2,
      partial: 1,
      complete: false,
    });
    expect(
      inspectCoverage(
        [
          { number: 1, kind: "normal" },
          { number: 4, kind: "normal" },
        ],
        [row(1), row(4)],
        "en",
        "audio",
        2,
      ).complete,
    ).toBe(false);
  });
  test("equal conflicting provider evidence abstains, manual verification wins", () => {
    const votes = [row(1), row(1, "missing", "other-provider"), row(2, "missing")];
    expect(inspectCoverage(episodes, votes, "en", "audio", 2)).toMatchObject({
      available: 0,
      missing: 1,
      unknown: 1,
    });
    expect(
      inspectCoverage(episodes, [...votes, row(1, "available", "manual", 10)], "en", "audio", 2),
    ).toMatchObject({ available: 1, missing: 1, unknown: 0 });
    expect(inspectCoverage(episodes, votes, "en", "subtitle", 2)).toMatchObject({
      available: 0,
      missing: 0,
      unknown: 2,
    });
  });
  test("empty or duplicated episode records cannot inflate the denominator", () => {
    expect(inspectCoverage([], [], "en", "audio", 0)).toMatchObject({
      recorded: 0,
      expected: null,
      complete: false,
    });
    expect(
      inspectCoverage([...episodes, episodes[0]!], [row(1), row(2)], "en", "audio", 2),
    ).toMatchObject({ recorded: 2, complete: true });
  });
});
