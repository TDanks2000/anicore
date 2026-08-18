import { describe, expect, test } from "bun:test";

import {
  earliestProviderAirDate,
  MAX_PROVIDER_START_DATE_DELTA_DAYS,
  verifyProviderSeasonAirdate,
} from "./provider-season-airdate-verification";

describe("provider season airdate verification", () => {
  test("accepts provider and AniList starts within the conservative window", () => {
    const result = verifyProviderSeasonAirdate({
      targetStartDate: "2018-10-06",
      providerFirstAirDate: "2018-10-06",
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.startDateDeltaDays).toBe(0);
  });

  test("allows small provider date drift but not different adaptations", () => {
    const inside = verifyProviderSeasonAirdate({
      targetStartDate: "2018-10-06",
      providerFirstAirDate: "2019-01-01",
    });
    expect(inside.ok).toBe(true);
    expect(inside.startDateDeltaDays).toBeLessThanOrEqual(
      MAX_PROVIDER_START_DATE_DELTA_DAYS,
    );

    const remake = verifyProviderSeasonAirdate({
      targetStartDate: "1966-10-04",
      providerFirstAirDate: "1986-01-06",
    });
    expect(remake.ok).toBe(false);
    expect(remake.reason).toBe("provider-start-date-mismatch");
  });

  test("fails closed when either date is missing or malformed", () => {
    expect(
      verifyProviderSeasonAirdate({
        targetStartDate: null,
        providerFirstAirDate: "2018-10-06",
      }).reason,
    ).toBe("target-start-date-unavailable");

    expect(
      verifyProviderSeasonAirdate({
        targetStartDate: "2018-10-06",
        providerFirstAirDate: "unknown",
      }).reason,
    ).toBe("provider-airdate-unavailable");
  });

  test("selects the earliest valid provider episode airdate", () => {
    expect(
      earliestProviderAirDate([
        null,
        "2018-10-20",
        "invalid",
        "2018-10-06",
        "2018-10-13",
      ]),
    ).toBe("2018-10-06");
  });
});
