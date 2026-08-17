import { describe, expect, test } from "bun:test";

import { normalizeComparableTitle, titleSimilarity } from "./title-similarity";

describe("title similarity", () => {
  test("normalizes punctuation and diacritics", () => {
    expect(normalizeComparableTitle("Pokémon: Horizons!")).toBe("pokemon horizons");
    expect(titleSimilarity("Pokémon: Horizons", "Pokemon Horizons")).toBe(1);
  });

  test("treats reordered identical tokens as a strong match", () => {
    expect(titleSimilarity("Hero Academia My", "My Hero Academia")).toBe(1);
  });

  test("does not overrate short titles that share one word", () => {
    expect(titleSimilarity("Blue Lock", "Blue Period")).toBeLessThan(0.5);
    expect(titleSimilarity("Love Live", "Love Stage")).toBeLessThan(0.5);
  });

  test("retains tolerance for small spelling differences", () => {
    expect(titleSimilarity("Cyberpunk Edgerunners", "Cyberpunk: Edgerunner")).toBeGreaterThan(0.7);
  });
});
