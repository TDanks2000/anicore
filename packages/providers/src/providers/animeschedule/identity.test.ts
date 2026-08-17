import { describe, expect, test } from "bun:test";

import {
  assertAnimeScheduleRouteCompatible,
  assertSingleAnimeScheduleIdentity,
} from "./identity";

describe("AnimeSchedule identity", () => {
  test("accepts zero or one cached route", () => {
    expect(assertSingleAnimeScheduleIdentity([])).toBeNull();
    expect(
      assertSingleAnimeScheduleIdentity([
        { providerId: "cowboy-bebop", source: "api", confidence: 100 },
      ]),
    ).toEqual({
      providerId: "cowboy-bebop",
      source: "api",
      confidence: 100,
    });
  });

  test("refuses to choose arbitrarily when multiple cached routes exist", () => {
    expect(() =>
      assertSingleAnimeScheduleIdentity([
        { providerId: "route-a", source: "api", confidence: 100 },
        { providerId: "route-b", source: "manual", confidence: 100 },
      ]),
    ).toThrow("Multiple AnimeSchedule identities");
  });

  test("prevents a verified search from adding a second route", () => {
    expect(() =>
      assertAnimeScheduleRouteCompatible(
        [{ providerId: "route-a", source: "api", confidence: 100 }],
        "route-b",
      ),
    ).toThrow("already has a different AnimeSchedule identity");

    expect(() =>
      assertAnimeScheduleRouteCompatible(
        [{ providerId: "route-a", source: "api", confidence: 100 }],
        "route-a",
      ),
    ).not.toThrow();
  });
});
