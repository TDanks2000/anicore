import { describe, expect, test } from "bun:test";

import { hasConflictingExplicitEpisodeNumbers } from "./episode-title-scoring";

describe("episode title scoring", () => {
  test("rejects provider batches whose explicit title numbers conflict", () => {
    expect(
      hasConflictingExplicitEpisodeNumbers([
        { number: 1, title: "Session #2: Stray Dog Strut" },
        { number: 2, title: "Session #3: Honky Tonk Women" },
        { number: 3, title: "Session #7: Heavy Metal Queen" },
      ]),
    ).toBe(true);
  });

  test("allows batches whose explicit title numbers line up", () => {
    expect(
      hasConflictingExplicitEpisodeNumbers([
        { number: 1, title: "Episode 1: Asteroid Blues" },
        { number: 2, title: "Episode 2: Stray Dog Strut" },
        { number: 3, title: "Episode 3: Honky Tonk Women" },
      ]),
    ).toBe(false);
  });
});
