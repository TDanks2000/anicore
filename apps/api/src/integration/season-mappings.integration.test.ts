import { afterAll, beforeEach, expect, test } from "bun:test";
import { closeDb, db } from "@anicore/db";
import { anime, animeMappings } from "@anicore/db/schema";
import { eq } from "drizzle-orm";
import { app } from "../app";
import { describeWithDatabase, resetTestDatabase } from "../test/database";

const previousToken = process.env.ANICORE_ADMIN_TOKEN;
let animeIds: number[];

function request(path: string, method = "GET", body?: unknown, authenticated = true) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(authenticated ? { Authorization: "Bearer season-test-token" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

function create(index = 0, extra = {}) {
  return request("/mappings/season", "POST", {
    animeId: animeIds[index],
    provider: "tmdb",
    providerSeriesId: " 100 ",
    seasonNumber: 3,
    ...extra,
  });
}

describeWithDatabase("season mappings", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    process.env.ANICORE_ADMIN_TOKEN = "season-test-token";
    const rows = await db
      .insert(anime)
      .values([{ titleRomaji: "Season three part one" }, { titleRomaji: "Season three part two" }])
      .returning();
    animeIds = rows.map((row) => row.id);
    await db.insert(animeMappings).values(
      rows.map((row, index) => ({
        animeId: row.id,
        provider: "anilist" as const,
        providerId: String(1000 + index),
      })),
    );
  });

  afterAll(async () => {
    if (previousToken === undefined) delete process.env.ANICORE_ADMIN_TOKEN;
    else process.env.ANICORE_ADMIN_TOKEN = previousToken;
    await closeDb();
  });

  test("maps split AniList entries to a shared season in part order", async () => {
    expect((await create(1, { partNumber: 2 })).status).toBe(200);
    const response = await create();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      providerSeriesId: "100",
      partNumber: 1,
      confidence: 100,
    });
    const list = await request("/mappings/season/tmdb/100?seasonNumber=3", "GET", undefined, false);
    expect(list.status).toBe(200);
    const entries = await list.json();
    expect(entries.map((entry: { anime: { id: number } }) => entry.anime.id)).toEqual(animeIds);
    expect(await (await request("/mappings/season/tmdb/100?seasonNumber=2")).json()).toEqual([]);
    expect(await (await request(`/anime/${animeIds[0]}/season-mappings`)).json()).toHaveLength(1);
    expect(await (await request(`/anime/${animeIds[0]}/full`)).json()).toMatchObject({
      seasonMappings: [{ seasonNumber: 3 }],
    });
  });

  test("rejects conflicting parts and duplicate anime associations", async () => {
    await create();
    expect((await create(1)).status).toBe(409);
    expect((await create(0, { partNumber: 2 })).status).toBe(409);
    const second = await (await create(1, { partNumber: 2 })).json();
    expect(
      (await request(`/mappings/season/${second.id}`, "PATCH", { partNumber: 1 })).status,
    ).toBe(409);
  });

  test("supports specials, updates, deletion and cascading anime deletion", async () => {
    const mapping = await (await create(0, { seasonNumber: 0 })).json();
    expect(
      await (await request(`/mappings/season/${mapping.id}`, "PATCH", { confidence: 80 })).json(),
    ).toMatchObject({ seasonNumber: 0, confidence: 80 });
    expect((await request(`/mappings/season/${mapping.id}`, "DELETE")).status).toBe(200);
    expect((await request(`/mappings/season/${mapping.id}`, "DELETE")).status).toBe(404);
    await create();
    await db.delete(anime).where(eq(anime.id, animeIds[0]!));
    expect(await (await request("/mappings/season/tmdb/100")).json()).toEqual([]);
  });

  test("validates inputs, parents and write authorization", async () => {
    expect((await create(0, { seasonNumber: -1 })).status).toBe(400);
    expect((await create(0, { partNumber: 0 })).status).toBe(400);
    expect((await create(0, { providerSeriesId: " " })).status).toBe(400);
    expect((await create(0, { animeId: 999999 })).status).toBe(404);
    expect(
      (
        await request(
          "/mappings/season",
          "POST",
          { animeId: animeIds[0], provider: "tmdb", providerSeriesId: "100", seasonNumber: 1 },
          false,
        )
      ).status,
    ).toBe(401);
  });
});
