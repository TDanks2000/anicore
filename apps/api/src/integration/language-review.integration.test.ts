import { afterAll, beforeEach, expect, test } from "bun:test";
import { closeDb, db } from "@anicore/db";
import { anime, animeLanguageStatus } from "@anicore/db/schema";
import { app } from "../app";
import { describeWithDatabase, resetTestDatabase } from "../test/database";

const TOKEN = "review-integration-token";
const previousToken = process.env.ANICORE_ADMIN_TOKEN;

async function request(query = "", token: string | null = TOKEN) {
  return app.handle(
    new Request(`http://localhost/admin/language-status/review-queue${query}`, {
      headers: token ? { Authorization: `Bearer ${token}`, Origin: "http://localhost:5173" } : {},
    }),
  );
}

describeWithDatabase("language review workspace", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    process.env.ANICORE_ADMIN_TOKEN = TOKEN;
    const [title] = await db
      .insert(anime)
      .values({ titleRomaji: "Review title", titleEnglish: "English title" })
      .returning();
    await db.insert(animeLanguageStatus).values([
      {
        animeId: title!.id,
        languageCode: "en",
        mediaType: "audio",
        status: "unknown",
        confidence: 0,
      },
      {
        animeId: title!.id,
        languageCode: "pt",
        mediaType: "audio",
        status: "possible",
        confidence: 30,
      },
      {
        animeId: title!.id,
        languageCode: "en",
        mediaType: "subtitle",
        status: "possible",
        confidence: 40,
      },
      {
        animeId: title!.id,
        languageCode: "fr",
        mediaType: "audio",
        status: "confirmed",
        confidence: 90,
      },
      {
        animeId: title!.id,
        languageCode: "de",
        mediaType: "audio",
        status: "unknown",
        confidence: 0,
        isManualOverride: true,
      },
    ]);
  });

  afterAll(async () => {
    if (previousToken === undefined) delete process.env.ANICORE_ADMIN_TOKEN;
    else process.env.ANICORE_ADMIN_TOKEN = previousToken;
    await closeDb();
  });

  test("preserves default rows and excludes confirmed/manual results", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    const rows = (await response.json()) as Array<{
      confidence: number;
      isManualOverride: boolean;
    }>;
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.confidence)).toEqual([0, 30, 40]);
    expect(rows[0]).not.toHaveProperty("anime");
    expect(response.headers.get("X-Total-Count")).toBe("3");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("enriches paged results without changing the filtered total", async () => {
    const response = await request("?includeAnime=true&limit=1&offset=1");
    const rows = (await response.json()) as Array<{
      anime: { titleRomaji: string };
      languageCode: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      languageCode: "pt",
      anime: { titleRomaji: "Review title", titleEnglish: "English title" },
    });
    expect(response.headers.get("X-Total-Count")).toBe("3");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("X-Total-Count");
    const empty = await request("?includeAnime=true&offset=20");
    expect(await empty.json()).toEqual([]);
    expect(empty.headers.get("X-Total-Count")).toBe("3");
  });

  test("normalizes regional language filters and combines media/status filters", async () => {
    const response = await request(
      "?includeAnime=true&languageCode=pt-BR&mediaType=audio&status=possible",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([
      { languageCode: "pt", mediaType: "audio", status: "possible" },
    ]);
    expect(response.headers.get("X-Total-Count")).toBe("1");
    const empty = await request("?languageCode=pt&mediaType=subtitle");
    expect(await empty.json()).toEqual([]);
    expect(empty.headers.get("X-Total-Count")).toBe("0");
  });

  test("requires admin credentials and rejects invalid filters", async () => {
    expect((await request("", null)).status).toBe(401);
    expect((await request("", "monitor-code")).status).toBe(401);
    expect((await request("?status=confirmed")).status).toBe(400);
    expect((await request("?mediaType=invalid")).status).toBe(400);
    expect((await request("?limit=101")).status).toBe(400);
    delete process.env.ANICORE_ADMIN_TOKEN;
    expect((await request()).status).toBe(503);
  });
});
