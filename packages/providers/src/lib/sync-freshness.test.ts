import { describe, expect, test } from "bun:test";
import { allSyncStagesFresh, animeRefreshTtl, type FreshnessStage } from "./sync-freshness";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const now = Date.parse("2026-10-06T00:00:00Z");

describe("schedule-aware sync freshness", () => {
  test("distant releases back off and become due before the release window", () => {
    const data = { status: "NOT_YET_RELEASED", startDate: "2027-01-01" };
    expect(animeRefreshTtl(data, false, now)).toBe(30 * DAY);
    expect(animeRefreshTtl(data, true, now)).toBe(30 * DAY);
    expect(animeRefreshTtl({ ...data, startDate: "2026-10-16" }, false, now)).toBe(3 * DAY);
    expect(animeRefreshTtl({ ...data, startDate: "2026-10-10" }, false, now)).toBe(6 * HOUR);
  });

  test("unknown release dates remain discoverable and stale dates stay conservative", () => {
    expect(animeRefreshTtl({ status: "NOT_YET_RELEASED" }, false, now)).toBe(7 * DAY);
    expect(animeRefreshTtl({ status: "NOT_YET_RELEASED", startDate: "invalid" }, false, now)).toBe(
      7 * DAY,
    );
    expect(
      animeRefreshTtl({ status: "NOT_YET_RELEASED", startDate: "2026-01-01" }, false, now),
    ).toBe(6 * HOUR);
    expect(animeRefreshTtl({ status: "unknown" }, false, now)).toBe(6 * HOUR);
  });

  test("airing schedules wake up after an episode and retain daily metadata checks", () => {
    expect(
      animeRefreshTtl(
        { status: "RELEASING", nextEpisodeAirsAt: (now + 2 * HOUR) / 1000 },
        false,
        now,
      ),
    ).toBe(3 * HOUR);
    expect(
      animeRefreshTtl(
        { status: "RELEASING", nextEpisodeAirsAt: (now + 7 * DAY) / 1000 },
        false,
        now,
      ),
    ).toBe(DAY);
    expect(
      animeRefreshTtl({ status: "RELEASING", nextEpisodeAirsAt: (now - HOUR) / 1000 }, false, now),
    ).toBe(6 * HOUR);
    expect(animeRefreshTtl({ status: "FINISHED" }, false, now)).toBe(7 * DAY);
    expect(animeRefreshTtl({ status: "FINISHED" }, true, now)).toBe(DAY);
  });

  test("skip requires every required stage, including independent language checks", () => {
    const fresh: FreshnessStage = {
      stage: "anilist-fetch",
      failures: 0,
      nextDueAt: now + DAY,
      payloadJson: "{}",
    };
    const language = { ...fresh, stage: "language:animeschedule" };
    const required = [fresh.stage, language.stage];
    expect(allSyncStagesFresh([fresh, language], required, now)).toBe(true);
    expect(allSyncStagesFresh([fresh], required, now)).toBe(false);
    for (const update of [
      { nextDueAt: now },
      { failures: 1 },
      { payloadJson: null },
      { payloadJson: "broken" },
    ]) {
      expect(allSyncStagesFresh([fresh, { ...language, ...update }], required, now)).toBe(false);
    }
    expect(
      allSyncStagesFresh(
        [fresh, language, { ...fresh, stage: "old-stage", failures: 1 }],
        required,
        now,
      ),
    ).toBe(false);
  });
});
