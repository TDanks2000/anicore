import { describe, expect, test } from "bun:test";
import type { ProviderAnimeData, ProviderPlugin } from "../providers/types";
import type { ProgressBar } from "./logger";
import { SyncEngine } from "./sync-engine";

const anilistData: ProviderAnimeData = {
  provider: "anilist",
  providerId: "999999999",
  titleRomaji: "Sync Engine Test",
};

function fakeProgressBar(): ProgressBar {
  const bar = {
    setStage: () => bar,
  };
  return bar as unknown as ProgressBar;
}

describe("SyncEngine.syncPlugins", () => {
  test("runs every provider then rejects the item when providers fail", async () => {
    const calls: string[] = [];
    const plugins: ProviderPlugin[] = [
      {
        name: "kitsu",
        sync: async () => {
          calls.push("kitsu");
          return { status: "error", message: "identity conflict" };
        },
      },
      {
        name: "animeschedule",
        sync: async () => {
          calls.push("animeschedule");
          throw new Error("provider unavailable");
        },
      },
    ];
    const engine = new SyncEngine(plugins);
    for (const set of engine.unmatchedSets.values()) set.clear();

    await expect(engine.syncPlugins(999999999, anilistData, fakeProgressBar())).rejects.toThrow(
      "Provider sync failed for AniList 999999999: kitsu: identity conflict; animeschedule: provider unavailable",
    );

    expect(calls).toEqual(["kitsu", "animeschedule"]);
  });
});

describe("SyncEngine.iterateParallel", () => {
  test("rejects unbounded or invalid prefetch windows", async () => {
    const engine = new SyncEngine([]);
    for (const concurrency of [0, 33, Number.POSITIVE_INFINITY]) {
      await expect(
        engine.iterateParallel(
          { ids: [1], startIndex: 0, endIndex: 1, label: "bounded", concurrency, rateLimitMs: 0 },
          async () => 1,
          async () => ({ outcome: "updated" }),
        ),
      ).rejects.toThrow("between 1 and 32");
    }
  });
  test("processes in order while later bounded fetches are still pending", async () => {
    const engine = new SyncEngine([]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processed: number[] = [];
    await engine.iterateParallel(
      {
        ids: [1, 2],
        startIndex: 0,
        endIndex: 2,
        label: "pipeline",
        concurrency: 2,
        rateLimitMs: 0,
      },
      async (id) => {
        if (id === 2) await gate;
        return id;
      },
      async (id) => {
        processed.push(id);
        if (id === 1) release();
        return { outcome: "updated" };
      },
    );
    expect(processed).toEqual([1, 2]);
  });
  test("fetches a batch in parallel before processing it sequentially", async () => {
    const engine = new SyncEngine([]);
    const calls: string[] = [];

    await engine.iterateParallel(
      {
        ids: [1, 2],
        startIndex: 0,
        endIndex: 2,
        label: "test",
        concurrency: 2,
        rateLimitMs: 0,
      },
      async (id) => {
        calls.push(`fetch-start-${id}`);
        if (id === 1) await Bun.sleep(1);
        calls.push(`fetch-end-${id}`);
        return id * 10;
      },
      async (id, _index, _bar, fetched) => {
        calls.push(`process-${id}-${fetched}`);
        return { outcome: "updated" };
      },
    );

    expect(calls.indexOf("process-1-10")).toBeGreaterThan(calls.indexOf("fetch-end-1"));
    expect(calls.indexOf("process-1-10")).toBeGreaterThan(calls.indexOf("fetch-end-2"));
    expect(calls.indexOf("process-2-20")).toBeGreaterThan(calls.indexOf("process-1-10"));
  });

  test("backs off to sequential fetches after reported request failures", async () => {
    const engine = new SyncEngine([]);
    const calls: string[] = [];

    await engine.iterateParallel(
      {
        ids: [1, 2, 3, 4],
        startIndex: 0,
        endIndex: 4,
        label: "test",
        concurrency: 2,
        rateLimitMs: 0,
      },
      async (id, _index, reportIssue) => {
        calls.push(`fetch-start-${id}`);
        if (id === 1) reportIssue("rate-limit");
        return id;
      },
      async (id) => {
        calls.push(`process-${id}`);
        return { outcome: "updated" };
      },
    );

    expect(calls.indexOf("process-3")).toBeGreaterThan(calls.indexOf("fetch-start-3"));
    expect(calls.indexOf("fetch-start-4")).toBeGreaterThan(calls.indexOf("process-3"));
  });

  test("does not back off when AniList reports missing IDs", async () => {
    const engine = new SyncEngine([]);
    const calls: string[] = [];

    const stats = await engine.iterateParallel(
      {
        ids: [1, 2, 3, 4],
        startIndex: 0,
        endIndex: 4,
        label: "test",
        concurrency: 2,
        rateLimitMs: 0,
      },
      async (id) => {
        calls.push(`fetch-start-${id}`);
        if (id <= 2) throw new Error("Request failed with status 404");
        return id;
      },
      async (id) => {
        calls.push(`process-${id}`);
        return { outcome: "updated" };
      },
    );

    expect(stats.failed).toBe(2);
    // Still parallel: ID 4 starts fetching before ID 3 is processed.
    expect(calls.indexOf("fetch-start-4")).toBeLessThan(calls.indexOf("process-3"));
  });

  test("counts skipped outcomes separately from failures", async () => {
    const engine = new SyncEngine([]);

    const stats = await engine.iterateParallel(
      { ids: [1, 2], startIndex: 0, endIndex: 2, label: "test", concurrency: 2, rateLimitMs: 0 },
      async (id) => (id === 1 ? null : id),
      async (_id, _index, _bar, fetched) => ({ outcome: fetched === null ? "skipped" : "updated" }),
    );

    expect(stats).toEqual({ created: 0, updated: 1, failed: 0, skipped: 1 });
  });
});
