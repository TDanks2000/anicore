import { describe, expect, test } from "bun:test";

import {
  animeDescriptionText,
  animeEpisodeTitle,
  animeFormatLabel,
  animeFormatVariant,
  animeProviderLabel,
  animeScoreTone,
  animeSecondaryTitle,
  animeStatusLabel,
  animeStatusVariant,
  animeYearOptions,
  formatSeasonYear,
  segmentRangeLabel,
} from "./anime-format";

describe("anime formatting", () => {
  test("labels known values and passes unknown ones through", () => {
    expect(animeFormatLabel("TV_SHORT")).toBe("TV Short");
    expect(animeFormatLabel("MANGA")).toBe("MANGA");
    expect(animeFormatLabel(null)).toBe("—");
    expect(animeStatusLabel("NOT_YET_RELEASED")).toBe("Not yet released");
    expect(animeStatusLabel(null)).toBe("—");
  });

  test("combines season and year, tolerating either being missing", () => {
    expect(formatSeasonYear("SPRING", 2024)).toBe("Spring 2024");
    expect(formatSeasonYear("FALL", null)).toBe("Fall");
    expect(formatSeasonYear(null, 2024)).toBe("2024");
    expect(formatSeasonYear(null, null)).toBe("—");
  });

  test("picks the first alternative title that differs from romaji", () => {
    expect(
      animeSecondaryTitle({
        titleRomaji: "Shingeki no Kyojin",
        titleEnglish: "Attack on Titan",
        titleNative: "進撃の巨人",
      }),
    ).toBe("Attack on Titan");
    expect(
      animeSecondaryTitle({
        titleRomaji: "Same",
        titleEnglish: "Same",
        titleNative: "Same",
      }),
    ).toBeNull();
    expect(
      animeSecondaryTitle({ titleRomaji: "Only", titleEnglish: null, titleNative: null }),
    ).toBeNull();
  });

  test("maps scores to tones at the thresholds", () => {
    expect(animeScoreTone(90)).toBe("success");
    expect(animeScoreTone(75)).toBe("success");
    expect(animeScoreTone(74)).toBe("primary");
    expect(animeScoreTone(60)).toBe("primary");
    expect(animeScoreTone(59)).toBe("warning");
    expect(animeScoreTone(40)).toBe("warning");
    expect(animeScoreTone(39)).toBe("muted");
    expect(animeScoreTone(null)).toBe("muted");
  });

  test("maps formats and statuses to badge variants", () => {
    expect(animeFormatVariant("TV")).toBe("default");
    expect(animeFormatVariant("MOVIE")).toBe("secondary");
    expect(animeFormatVariant("OVA")).toBe("outline");
    expect(animeFormatVariant(null)).toBe("outline");
    expect(animeStatusVariant("RELEASING")).toBe("success");
    expect(animeStatusVariant("CANCELLED")).toBe("destructive");
    expect(animeStatusVariant(null)).toBe("outline");
  });

  test("strips provider HTML from descriptions without losing line breaks", () => {
    expect(animeDescriptionText("Line one<br>Line two<br/>Line three")).toBe(
      "Line one\nLine two\nLine three",
    );
    expect(animeDescriptionText("<i>Styled</i> <b>text</b>")).toBe("Styled text");
    expect(animeDescriptionText("   ")).toBeNull();
    expect(animeDescriptionText(null)).toBeNull();
  });

  test("falls back through episode titles", () => {
    const base = { number: 3, title: null, titleEnglish: null, titleRomaji: null };
    expect(animeEpisodeTitle({ ...base, title: "A" })).toBe("A");
    expect(animeEpisodeTitle({ ...base, titleEnglish: "B" })).toBe("B");
    expect(animeEpisodeTitle({ ...base, titleRomaji: "C" })).toBe("C");
    expect(animeEpisodeTitle(base)).toBe("Episode 3");
  });

  test("labels providers with their public names", () => {
    expect(animeProviderLabel("anilist")).toBe("AniList");
    expect(animeProviderLabel("mal")).toBe("MyAnimeList");
    expect(animeProviderLabel("thetvdb")).toBe("TheTVDB");
    expect(animeProviderLabel("crunchyroll")).toBe("Crunchyroll");
    expect(animeProviderLabel("unknown-provider")).toBe("unknown-provider");
  });

  test("year options run newest-first and include next year", () => {
    const years = animeYearOptions(2026);
    expect(years[0]).toBe(2027);
    expect(years).toContain(2026);
    expect(years.at(-1)).toBe(1940);
  });

  test("labels provider episode ranges against local numbering", () => {
    const segment = (a: number, b: number, c: number, d: number) => ({
      providerEpisodeStart: a,
      providerEpisodeEnd: b,
      localEpisodeStart: c,
      localEpisodeEnd: d,
    });
    expect(segmentRangeLabel(segment(1, 26, 1, 26))).toBe("eps 1–26");
    expect(segmentRangeLabel(segment(50, 59, 1, 10))).toBe("eps 50–59 → 1–10");
    expect(segmentRangeLabel(segment(7, 7, 1, 1))).toBe("eps 7 → 1");
  });
});
