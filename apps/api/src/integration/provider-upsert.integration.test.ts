import { afterAll, beforeEach, expect, test } from "bun:test";
import { closeDb, db } from "@anicore/db";
import { anime, animeExternalLinks, animeMappings, studios, tags } from "@anicore/db/schema";
import { upsertAnimeFromProvider } from "@anicore/providers";
import type { ProviderAnimeData } from "@anicore/providers/types";
import { eq } from "drizzle-orm";

import { app } from "../app";
import { describeWithDatabase, resetTestDatabase } from "../test/database";

function record(providerId: string, overrides: Partial<ProviderAnimeData> = {}): ProviderAnimeData {
  return {
    provider: "anilist",
    providerId,
    titleRomaji: "Shared Title",
    studios: [{ name: "Studio Bones", isMain: true, isAnimationStudio: true, anilistStudioId: 4 }],
    tags: [{ name: "Space", rank: 90 }],
    ...overrides,
  };
}

describeWithDatabase("provider upsert", () => {
  beforeEach(resetTestDatabase);
  afterAll(closeDb);

  test("concurrent writers of one new record create exactly one anime", async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => upsertAnimeFromProvider(record("1"))),
    );

    expect(new Set(results.map((result) => result.animeId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await db.select().from(anime)).toHaveLength(1);
    expect(await db.select().from(animeMappings)).toMatchObject([
      { provider: "anilist", providerId: "1", isPrimary: true, source: "api" },
    ]);
  });

  test("concurrent records sharing a title, studio and tag get distinct slugs and shared entities", async () => {
    await Promise.all(["1", "2", "3"].map((id) => upsertAnimeFromProvider(record(id))));

    const slugs = (await db.select({ slug: anime.slug }).from(anime)).map((row) => row.slug);
    expect(new Set(slugs).size).toBe(3);
    expect(slugs).toContain("shared-title");
    expect(await db.select().from(studios)).toHaveLength(1);
    expect(await db.select().from(tags)).toHaveLength(1);
  });

  test("refreshes existing rows, merges entity flags and tolerates duplicate links", async () => {
    const { animeId } = await upsertAnimeFromProvider(record("1"));
    const again = await upsertAnimeFromProvider(
      record("1", {
        titleRomaji: "Renamed",
        tags: [{ name: " SPACE ", rank: 80, isMediaSpoiler: true }],
        externalLinks: [
          { site: "Official", url: "https://example.com" },
          { site: "Official", url: "https://example.com" },
        ],
      }),
    );

    expect(again).toEqual({ animeId, created: false });
    const [row] = await db.select().from(anime).where(eq(anime.id, animeId));
    // The slug is stable across renames.
    expect(row).toMatchObject({ titleRomaji: "Renamed", slug: "shared-title" });
    expect(await db.select().from(tags)).toMatchObject([{ name: "Space", isMediaSpoiler: true }]);
    expect(await db.select().from(animeExternalLinks)).toHaveLength(1);
  });

  test("manual creates without a slug get one from the title", async () => {
    const create = (body: unknown) =>
      app.handle(
        new Request("http://localhost/anime", {
          method: "POST",
          headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    process.env.ANICORE_ADMIN_TOKEN = "t";

    const first = (await (await create({ titleRomaji: "Monster" })).json()) as { slug: string };
    const second = (await (await create({ titleRomaji: "Monster" })).json()) as { slug: string };
    expect([first.slug, second.slug]).toEqual(["monster", "monster-2"]);
    delete process.env.ANICORE_ADMIN_TOKEN;
  });
});
