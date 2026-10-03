import { describe, expect, spyOn, test } from "bun:test";
import {
  type AnimeScheduleEntry,
  hasLanguageTrack,
  parseAnilistId,
  parseKitsuReference,
  parseMalId,
  searchByAnilistId,
  validateEntry,
  validScheduleDate,
} from "./client";

describe("catalogue URL verification", () => {
  test("parses only the right host and a whole positive numeric ID", () => {
    expect(parseAnilistId("anilist.co/anime/1/Cowboy-Bebop")).toBe("1");
    expect(parseMalId("https://www.myanimelist.net/anime/5/Example?x=1")).toBe("5");
    for (const url of [
      "https://evil.test/anime/1",
      "https://anilist.co.evil.test/anime/1",
      "https://anilist.co/anime/1abc",
      "https://anilist.co/anime/0",
      "https://anilist.co/anime/01",
      "https://evil.test/?u=https://anilist.co/anime/1",
      "https://user@anilist.co/anime/1",
    ])
      expect(parseAnilistId(url)).toBeNull();
    expect(parseKitsuReference("https://evil.test/anime/12")).toEqual({
      kitsuId: null,
      kitsuSlug: null,
    });
    expect(parseKitsuReference("kitsu.app/anime/cowboy-bebop")).toEqual({
      kitsuId: null,
      kitsuSlug: "cowboy-bebop",
    });
  });
  test("invalid, empty, missing, and Go-zero dates are not premieres", () => {
    for (const value of [null, undefined, "", "0001-01-01T00:00:00Z", "TBD", "nonsense"])
      expect(validScheduleDate(value)).toBeNull();
  });
});

describe("AnimeSchedule documented release markers", () => {
  const entry = {
    dubPremier: "",
    subPremier: "",
    jpnTime: "2023-01-01T16:00:00Z",
  } as AnimeScheduleEntry;
  test("ignores midnight, TBD and matching raw clocks, comparing only hour and minute", () => {
    for (const dubTime of [
      null,
      "",
      "0001-01-01T00:00:00Z",
      "2024-01-01T00:00:00Z",
      "2024-01-01T16:00:00Z",
    ])
      expect(hasLanguageTrack({ ...entry, dubTime }, "audio")).toBe(false);
    expect(
      hasLanguageTrack({ ...entry, dubTime: "2024-01-01T16:01:00Z", dubTimeTBD: true }, "audio"),
    ).toBe(false);
    expect(hasLanguageTrack({ ...entry, dubTime: "2024-01-01T16:01:00Z" }, "audio")).toBe(true);
  });
  test("an explicit midnight premiere still identifies a language track", () => {
    expect(hasLanguageTrack({ ...entry, dubPremier: "2024-01-01T00:00:00Z" }, "audio")).toBe(true);
  });
  test("rejects malformed identity and website fields", () => {
    for (const value of [
      null,
      {},
      { route: "x", title: "" },
      { route: "../x", title: "X" },
      { route: "x", title: "X", websites: { aniList: 1 } },
    ])
      expect(() => validateEntry(value)).toThrow();
  });
});

test("an interrupted search cannot accept a partial set of identity candidates", async () => {
  const request = spyOn(globalThis, "fetch").mockImplementation((async (
    input: URL | RequestInfo,
  ) => {
    const page = new URL(String(input)).searchParams.get("page");
    return page === "1"
      ? Response.json({ totalAmount: 2, anime: [{ route: "cowboy-bebop", title: "Cowboy Bebop" }] })
      : new Response(null, { status: 404 });
  }) as typeof fetch);
  try {
    await expect(searchByAnilistId("1")).rejects.toThrow("Incomplete");
  } finally {
    request.mockRestore();
  }
});
