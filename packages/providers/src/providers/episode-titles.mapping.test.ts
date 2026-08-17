import { describe, expect, test } from "bun:test";

import { selectPreferredAnimeSourceMapping } from "./episode-titles";

const base = {
  confidence: 85,
  source: "fuzzy" as const,
  isPrimary: false,
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("episode source mapping preference", () => {
  test("always prefers an explicitly primary mapping", () => {
    const fuzzyPrimary = { ...base, id: 1, isPrimary: true };
    const manual = {
      ...base,
      id: 2,
      source: "manual" as const,
      confidence: 100,
    };

    expect(selectPreferredAnimeSourceMapping([manual, fuzzyPrimary])).toBe(
      fuzzyPrimary,
    );
  });

  test("prefers stronger provenance when no mapping is primary", () => {
    const fuzzy = { ...base, id: 1, confidence: 99 };
    const manual = {
      ...base,
      id: 2,
      source: "manual" as const,
      confidence: 80,
    };

    expect(selectPreferredAnimeSourceMapping([fuzzy, manual])).toBe(manual);
  });

  test("uses confidence, recency, then id as deterministic tie breakers", () => {
    const older = { ...base, id: 1, confidence: 90 };
    const newer = {
      ...base,
      id: 2,
      confidence: 90,
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    };

    expect(selectPreferredAnimeSourceMapping([older, newer])).toBe(newer);
  });

  test("returns null when no mapping exists", () => {
    expect(selectPreferredAnimeSourceMapping([])).toBeNull();
  });
});
