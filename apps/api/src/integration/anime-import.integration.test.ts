import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { closeDb } from "@anicore/db";
import { upsertAnimeFromProvider } from "@anicore/providers";
import * as realCache from "@anicore/providers/lib/cache";
import type { ProviderAnimeData } from "@anicore/providers/types";

import { describeWithDatabase, resetTestDatabase } from "../test/database";

const TOKEN = "integration-admin-token";
const fetchCalls: number[] = [];
const queuedIds: number[] = [];

function fixture(id: number): ProviderAnimeData {
  return {
    provider: "anilist",
    providerId: String(id),
    titleRomaji: `Imported ${id}`,
    genres: ["Drama"],
  };
}

// Stand in for the network: AniList knows only ID 1. The real upsert still runs.
mock.module("@anicore/providers/anilist/sync", () => ({
  syncAnilistAnime: async (id: number) => {
    fetchCalls.push(id);
    await Bun.sleep(20);
    if (id !== 1) throw new Error(`AniList returned no media for ID ${id}`);
    const data = fixture(id);
    return { ...(await upsertAnimeFromProvider(data)), data };
  },
}));
mock.module("@anicore/providers/lib/cache", () => ({
  ...realCache,
  appendAnilistId: (id: number) => queuedIds.push(id),
}));

const { app } = await import("../app");

function importAnime(body: unknown, token = TOKEN) {
  return app.handle(
    new Request("http://localhost/anime/import/anilist", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describeWithDatabase("AniList import", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    fetchCalls.length = 0;
    queuedIds.length = 0;
    process.env.ANICORE_ADMIN_TOKEN = TOKEN;
  });

  afterAll(async () => {
    delete process.env.ANICORE_ADMIN_TOKEN;
    await closeDb();
  });

  test("requires the admin token", async () => {
    expect((await importAnime({ id: 1 }, "wrong")).status).toBe(401);
    expect(fetchCalls).toEqual([]);
  });

  test("creates, then refreshes, and queues the ID for scheduled sync", async () => {
    const first = await importAnime({ id: 1 });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      created: true,
      anime: { titleRomaji: "Imported 1", genres: ["Drama"] },
    });

    const second = await importAnime({ id: 1 });
    expect(await second.json()).toMatchObject({ created: false });
    expect(queuedIds).toEqual([1, 1]);

    const lookup = await app.handle(new Request("http://localhost/anime/by/anilist/1"));
    expect(lookup.status).toBe(200);
  });

  test("shares one fetch between concurrent imports of the same ID", async () => {
    const responses = await Promise.all([importAnime({ id: 1 }), importAnime({ id: 1 })]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(fetchCalls).toEqual([1]);
  });

  test("reports unknown AniList IDs as 404 without queuing them", async () => {
    const response = await importAnime({ id: 2 });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "AniList has no anime with ID 2" });
    expect(queuedIds).toEqual([]);
  });

  test("validates the request body", async () => {
    expect((await importAnime({})).status).toBe(400);
    expect((await importAnime({ search: "   " })).status).toBe(400);
  });
});
