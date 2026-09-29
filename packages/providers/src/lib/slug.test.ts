import { describe, expect, test } from "bun:test";

import { slugCandidates, slugify } from "./slug";

function first(count: number, candidates: Iterable<string>): string[] {
  const out: string[] = [];
  for (const candidate of candidates) {
    out.push(candidate);
    if (out.length === count) break;
  }
  return out;
}

describe("slugify", () => {
  test("lowercases and hyphenates", () => {
    expect(slugify("  Cowboy Bebop: The Movie!  ")).toBe("cowboy-bebop-the-movie");
  });
});

describe("slugCandidates", () => {
  test("tries the title, then the qualified title, then numbered variants", () => {
    expect(first(4, slugCandidates("Cowboy Bebop", "1"))).toEqual([
      "cowboy-bebop",
      "cowboy-bebop-1",
      "cowboy-bebop-1-2",
      "cowboy-bebop-1-3",
    ]);
  });

  test("falls back to the discriminator for titles without Latin characters", () => {
    expect(first(3, slugCandidates("進撃の巨人", "16498"))).toEqual([
      "16498",
      "16498-2",
      "16498-3",
    ]);
  });

  test("works without a discriminator", () => {
    expect(first(3, slugCandidates("Naruto"))).toEqual(["naruto", "naruto-2", "naruto-3"]);
    expect(first(2, slugCandidates("!!!"))).toEqual(["anime", "anime-2"]);
  });
});
