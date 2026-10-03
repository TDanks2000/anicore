import { describe, expect, test } from "bun:test";

import type { AnimeLanguageStatusRow, EpisodeLanguageStatusRow } from "./anime-api";
import {
  animeLanguageStatusLabel,
  animeLanguageStatusTone,
  buildEpisodeStatusMap,
  episodeCoverage,
  episodeLanguageStatusLabel,
  episodeLanguageStatusTone,
  episodeLanguages,
  formatLanguageName,
  groupAnimeLanguageStatuses,
  languageEvidenceSource,
} from "./language-status";

function animeStatus(
  languageCode: string,
  mediaType: "audio" | "subtitle",
  status: string,
): AnimeLanguageStatusRow {
  return {
    id: Math.random(),
    animeId: 1,
    languageCode,
    mediaType,
    status,
    confidence: 90,
    isManualOverride: false,
    notes: null,
    checkedAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function episodeStatus(
  episodeNumber: number,
  languageCode: string,
  mediaType: "audio" | "subtitle",
  status: string,
): EpisodeLanguageStatusRow {
  return {
    id: Math.random(),
    animeId: 1,
    episodeNumber,
    languageCode,
    mediaType,
    status,
    provider: "manual",
    confidence: 80,
    checkedAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("language status helpers", () => {
  test("labels and tones statuses", () => {
    expect(animeLanguageStatusLabel("not_available")).toBe("Not available");
    expect(animeLanguageStatusTone("confirmed")).toBe("success");
    expect(animeLanguageStatusTone("partial")).toBe("warning");
    expect(animeLanguageStatusTone("not_available")).toBe("secondary");
    expect(episodeLanguageStatusLabel("missing")).toBe("Missing");
    expect(episodeLanguageStatusTone("available")).toBe("success");
    expect(episodeLanguageStatusTone("missing")).toBe("destructive");
    expect(episodeLanguageStatusTone("unknown")).toBe("outline");
  });

  test("names languages in English and falls back for odd codes", () => {
    expect(formatLanguageName("en")).toBe("English");
    expect(formatLanguageName("ja")).toBe("Japanese");
    expect(formatLanguageName("pt-br")).toBe("Brazilian Portuguese");
    expect(formatLanguageName("zz")).toBe("ZZ");
  });

  test("groups anime statuses by language and medium", () => {
    const grouped = groupAnimeLanguageStatuses([
      animeStatus("en", "audio", "confirmed"),
      animeStatus("ja", "subtitle", "confirmed"),
      animeStatus("en", "subtitle", "confirmed"),
    ]);

    expect(grouped.map((entry) => entry.languageCode)).toEqual(["en", "ja"]);
    expect(grouped[0]?.audio?.status).toBe("confirmed");
    expect(grouped[0]?.subtitle?.status).toBe("confirmed");
    expect(grouped[1]?.audio).toBeNull();
    expect(grouped[1]?.subtitle?.status).toBe("confirmed");
  });

  test("lists episode languages from both status sources", () => {
    expect(
      episodeLanguages(
        [episodeStatus(1, "ja", "subtitle", "available")],
        [animeStatus("en", "audio", "confirmed")],
      ),
    ).toEqual(["en", "ja"]);
  });

  test("maps episode statuses by episode, language and medium", () => {
    const map = buildEpisodeStatusMap([
      episodeStatus(1, "en", "audio", "available"),
      episodeStatus(1, "en", "subtitle", "available"),
      episodeStatus(2, "en", "audio", "missing"),
    ]);

    expect(map.get("1|en|audio")?.status).toBe("available");
    expect(map.get("1|en|subtitle")?.status).toBe("available");
    expect(map.get("2|en|audio")?.status).toBe("missing");
    expect(map.get("2|en|subtitle")).toBeUndefined();
  });

  test("counts confirmed and partial coverage against the episode total", () => {
    const rows = [
      episodeStatus(1, "en", "audio", "available"),
      episodeStatus(2, "en", "audio", "partial"),
      episodeStatus(3, "en", "audio", "missing"),
      episodeStatus(1, "ja", "audio", "available"),
    ];

    expect(episodeCoverage(rows, "en", "audio", 12)).toEqual({ available: 2, total: 12, known: 3 });
    expect(episodeCoverage(rows, "en", "subtitle", 12)).toEqual({
      available: 0,
      total: 12,
      known: 0,
    });
    expect(episodeCoverage(rows, "ja", "audio", 12)).toEqual({ available: 1, total: 12, known: 1 });
  });

  test("deduplicates providers, favors manual evidence, and leaves tied conflicts unknown", () => {
    const available = {
      ...episodeStatus(1, "en", "audio", "available"),
      provider: "provider-a",
      confidence: 90,
    };
    const duplicate = { ...available, provider: "provider-b" };
    const missing = { ...duplicate, status: "missing" };
    expect(episodeCoverage([available, duplicate], "en", "audio", 26)).toEqual({
      available: 1,
      total: 26,
      known: 1,
    });
    for (const rows of [
      [available, missing],
      [missing, available],
    ])
      expect(buildEpisodeStatusMap(rows).get("1|en|audio")?.status).toBe("unknown");
    expect(
      buildEpisodeStatusMap([available, { ...missing, provider: "manual", confidence: 75 }]).get(
        "1|en|audio",
      )?.status,
    ).toBe("missing");
    expect(episodeCoverage([available], "en", "audio", 26, new Set([2]))).toEqual({
      available: 0,
      total: 26,
      known: 0,
    });
  });

  test("names evidence sources from their URLs", () => {
    expect(
      languageEvidenceSource(
        "https://www.crunchyroll.com/series/GYVNXMVP6/cowboy-bebop",
        "provider",
      ),
    ).toBe("Crunchyroll episode tracks");
    expect(languageEvidenceSource("https://anilist.co/anime/1/characters", "provider")).toBe(
      "AniList voice cast",
    );
    expect(languageEvidenceSource(null, "manual")).toBe("Manual verification");
  });
});
