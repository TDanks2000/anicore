import { afterAll, beforeEach, expect, test } from "bun:test";
import { closeDb, db } from "@anicore/db";
import { syncStageState } from "@anicore/db/schema";
import { CrunchyrollAccessBlockedError } from "@anicore/providers/crunchyroll/client";
import { readStage, runSyncStage } from "@anicore/providers/lib/stage-state";
import { syncLanguageProviders } from "../lib/language-sync";
import { describeWithDatabase, resetTestDatabase } from "../test/database";

const providers = {
  crunchyroll: async () => null,
  "anilist-cast": async () => null,
  "kitsu-languages": async () => null,
};

describeWithDatabase("Crunchyroll challenge recovery", () => {
  beforeEach(resetTestDatabase);
  afterAll(closeDb);

  test("a challenge remains a failed retryable stage, while other language stages succeed", async () => {
    const executed: string[] = [];
    const run = () =>
      syncLanguageProviders(1, providers, <T>(name: string, _operation: () => Promise<T>) =>
        runSyncStage(123, `language:${name}`, 60_000, async () => {
          executed.push(name);
          if (name === "crunchyroll")
            throw new CrunchyrollAccessBlockedError(Date.now() + 900_000, 403);
          return null as T;
        }),
      );
    const first = await run();
    expect(first.errors).toEqual([]);
    expect(first.warnings).toHaveLength(1);
    expect(first.warnings[0]).toContain("Crunchyroll access blocked");
    expect(executed).toContain("kitsu-languages");
    expect(await readStage(123, "language:crunchyroll")).toMatchObject({
      failures: 1,
      successAt: null,
      payloadJson: null,
    });
    expect(await readStage(123, "language:anilist-cast")).toMatchObject({ failures: 0 });

    executed.length = 0;
    const second = await run();
    expect(second.errors).toEqual([]);
    expect(second.warnings).toHaveLength(1);
    expect(second.warnings[0]).toContain("retry cooling down");
    expect(executed).toEqual([]);
    expect(await readStage(123, "language:crunchyroll")).toMatchObject({ failures: 1 });

    await db.update(syncStageState).set({ retryAt: 0 });
    const recovered = await syncLanguageProviders(
      1,
      providers,
      <T>(name: string, _operation: () => Promise<T>) =>
        runSyncStage(123, `language:${name}`, 60_000, async () => null as T),
    );
    expect(recovered).toEqual({ errors: [], warnings: [] });
    expect(await readStage(123, "language:crunchyroll")).toMatchObject({
      failures: 0,
      error: null,
    });
  });

  test("identity and ordinary authorization errors remain required failures across retries", async () => {
    const run = () =>
      syncLanguageProviders(1, providers, <T>(name: string, _operation: () => Promise<T>) =>
        runSyncStage(456, `language:${name}`, 60_000, async () => {
          if (name === "crunchyroll") throw new Error("Crunchyroll token: 403: invalid_client");
          return null as T;
        }),
      );
    expect((await run()).errors).toHaveLength(1);
    const retry = await run();
    expect(retry.errors).toHaveLength(1);
    expect(retry.warnings).toEqual([]);
  });
});
