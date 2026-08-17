import { describe, expect, test } from "bun:test";

import {
  scoreSourceEpisodeBatch,
  selectSourceCandidate,
  sourceTitleSimilarity,
} from "./episode-source-matching";

const context = {
  seasonYear: 2024,
  episodeCount: 12,
  episodes: Array.from({ length: 12 }, (_, index) => ({
    number: index + 1,
    airDate: `2024-01-${String(index + 1).padStart(2, "0")}`,
  })),
};

function batch(count: number, year = 2024) {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: `Episode ${index + 1}`,
    airDate: `${year}-01-${String(index + 1).padStart(2, "0")}`,
  }));
}

describe("episode source title matching", () => {
  test("normalizes punctuation and diacritics", () => {
    expect(sourceTitleSimilarity("Pokémon: Horizons", "Pokemon Horizons")).toBe(1);
  });
});

describe("episode source batch scoring", () => {
  test("accepts a season with matching count, year, and dates", () => {
    expect(Number.isFinite(scoreSourceEpisodeBatch(context, batch(12)))).toBe(true);
  });

  test("rejects a season from a clearly different year", () => {
    expect(scoreSourceEpisodeBatch(context, batch(12, 2020))).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });

  test("rejects a season with a wildly different episode count", () => {
    expect(scoreSourceEpisodeBatch(context, batch(24))).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });

  test("does not reject a larger provider batch when the final local count is unknown", () => {
    const partialContext = {
      seasonYear: 2024,
      episodeCount: null,
      episodes: context.episodes.slice(0, 4),
    };

    expect(Number.isFinite(scoreSourceEpisodeBatch(partialContext, batch(12)))).toBe(true);
  });
});

describe("episode source candidate selection", () => {
  test("rejects near-tied season candidates", () => {
    expect(
      selectSourceCandidate([
        { value: "season-1", score: 150 },
        { value: "season-2", score: 145 },
      ]),
    ).toBeNull();
  });

  test("accepts a clearly better season candidate", () => {
    expect(
      selectSourceCandidate([
        { value: "season-1", score: 150 },
        { value: "season-2", score: 130 },
      ]),
    ).toBe("season-1");
  });
});
