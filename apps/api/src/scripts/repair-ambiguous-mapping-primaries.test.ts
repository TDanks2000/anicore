import { describe, expect, test } from "bun:test";

import {
  type AmbiguousMappingRow,
  electPrimaries,
  sourceRank,
} from "./repair-ambiguous-mapping-primaries";

function row(overrides: Partial<AmbiguousMappingRow> & { id: number }): AmbiguousMappingRow {
  return {
    animeId: 1,
    provider: "kitsu",
    providerId: `p${overrides.id}`,
    confidence: 90,
    source: "fuzzy",
    ...overrides,
  };
}

describe("sourceRank", () => {
  test("ranks known provenance strongest first", () => {
    expect(sourceRank("manual")).toBeLessThan(sourceRank("api"));
    expect(sourceRank("api")).toBeLessThan(sourceRank("system"));
    expect(sourceRank("system")).toBeLessThan(sourceRank("import"));
    expect(sourceRank("import")).toBeLessThan(sourceRank("fuzzy"));
  });

  test("sorts an unrecognised source last rather than throwing", () => {
    expect(sourceRank("something-new")).toBeGreaterThan(sourceRank("fuzzy"));
  });
});

describe("electPrimaries", () => {
  test("prefers the strongest confidence", () => {
    const elected = electPrimaries([
      row({ id: 1, confidence: 90 }),
      row({ id: 2, confidence: 100 }),
    ]);

    expect(elected).toHaveLength(1);
    expect(elected[0]?.winner.id).toBe(2);
    expect(elected[0]?.losers.map((loser) => loser.id)).toEqual([1]);
  });

  test("breaks a confidence tie on provenance", () => {
    const elected = electPrimaries([
      row({ id: 1, confidence: 100, source: "fuzzy" }),
      row({ id: 2, confidence: 100, source: "api" }),
    ]);

    expect(elected[0]?.winner.id).toBe(2);
  });

  test("breaks a full tie on the oldest row so the result is stable", () => {
    const rows = [
      row({ id: 7, confidence: 100, source: "api" }),
      row({ id: 3, confidence: 100, source: "api" }),
    ];

    expect(electPrimaries(rows)[0]?.winner.id).toBe(3);
    // Same input in the other order must elect the same winner.
    expect(electPrimaries([...rows].reverse())[0]?.winner.id).toBe(3);
  });

  test("groups independently by anime and provider", () => {
    const elected = electPrimaries([
      row({ id: 1, animeId: 1, provider: "kitsu", confidence: 90 }),
      row({ id: 2, animeId: 1, provider: "kitsu", confidence: 100 }),
      row({ id: 3, animeId: 1, provider: "tmdb", confidence: 85 }),
      row({ id: 4, animeId: 1, provider: "tmdb", confidence: 95 }),
      row({ id: 5, animeId: 2, provider: "kitsu", confidence: 90 }),
      row({ id: 6, animeId: 2, provider: "kitsu", confidence: 100 }),
    ]);

    expect(elected.map((group) => group.winner.id)).toEqual([2, 4, 6]);
  });

  test("ignores a provider that has only one mapping", () => {
    expect(electPrimaries([row({ id: 1 })])).toEqual([]);
  });

  test("returns nothing for an empty input", () => {
    expect(electPrimaries([])).toEqual([]);
  });
});
