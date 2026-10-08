import { beforeEach, expect, test } from "bun:test";
import { db } from "@anicore/db";
import { anime, animeMappings, syncStageState } from "@anicore/db/schema";
import { selectSyncIds } from "../lib/sync-cli";
import { loadNewSyncExcludedIds } from "../lib/sync-id-selection";
import { describeWithDatabase, resetTestDatabase } from "../test/database";

describeWithDatabase("new-ID sync selection", () => {
  beforeEach(resetTestDatabase);

  test("excludes cached missing IDs before ordering and limits, then retries when due", async () => {
    const now = 1_800_000_000_000;
    const [mapped] = await db.insert(anime).values({ titleRomaji: "Mapped" }).returning();
    await db.insert(animeMappings).values({
      animeId: mapped!.id,
      provider: "anilist",
      providerId: "1",
    });
    await db.insert(syncStageState).values([
      {
        key: "100:anilist-fetch",
        anilistId: 100,
        stage: "anilist-fetch",
        attemptedAt: now,
        payloadJson: "null",
        failures: 0,
        nextDueAt: now + 1000,
      },
      {
        key: "2:anilist-fetch",
        anilistId: 2,
        stage: "anilist-fetch",
        attemptedAt: now,
        payloadJson: "null",
        failures: 0,
        nextDueAt: now,
      },
      {
        key: "3:anilist-fetch",
        anilistId: 3,
        stage: "anilist-fetch",
        attemptedAt: now,
        payloadJson: "null",
        failures: 1,
        nextDueAt: now + 1000,
      },
      {
        key: "4:anilist-fetch",
        anilistId: 4,
        stage: "anilist-fetch",
        attemptedAt: now,
        payloadJson: "{}",
        failures: 0,
        nextDueAt: now + 1000,
      },
      {
        key: "5:provider:kitsu",
        anilistId: 5,
        stage: "provider:kitsu",
        attemptedAt: now,
        payloadJson: "null",
        failures: 0,
        nextDueAt: now + 1000,
      },
      {
        key: "6:anilist-fetch",
        anilistId: 6,
        stage: "anilist-fetch",
        attemptedAt: now,
        payloadJson: null,
        failures: 0,
        nextDueAt: now + 1000,
      },
      {
        key: "7:anilist-fetch",
        anilistId: 7,
        stage: "anilist-fetch",
        attemptedAt: now,
        payloadJson: "null",
        failures: 0,
        nextDueAt: null,
      },
    ]);
    const ids = [1, 2, 3, 4, 5, 6, 7, 100];
    const excluded = await loadNewSyncExcludedIds(false, now);
    expect(excluded).toEqual(new Set([1, 100]));
    expect(selectSyncIds(ids, excluded, true, true).slice(0, 2)).toEqual([7, 6]);
    expect(await loadNewSyncExcludedIds(false, now + 1000)).toEqual(new Set([1]));
    expect(await loadNewSyncExcludedIds(true, now)).toEqual(new Set([1]));
    // All-ID runs retain stable indexes for their saved checkpoints.
    expect(selectSyncIds(ids, excluded, false, false)).toEqual(ids);
  });
});
