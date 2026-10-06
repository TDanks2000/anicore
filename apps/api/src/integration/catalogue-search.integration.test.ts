import { afterAll, beforeEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { closeDb, db } from "@anicore/db";
import { getDatabaseConfig } from "@anicore/db/db-config";
import { anime } from "@anicore/db/schema";
import { createClient } from "@libsql/client";
import { and, asc, eq, sql } from "drizzle-orm";
import { escapeLikePattern, listAnime } from "../modules/anime/anime.service";
import { describeWithDatabase, resetTestDatabase } from "../test/database";

describeWithDatabase("catalogue search index", () => {
  beforeEach(resetTestDatabase);
  afterAll(closeDb);

  test("indexed searches agree with literal LIKE across all fields and special Unicode input", async () => {
    const fields = [
      anime.titleRomaji,
      anime.titleEnglish,
      anime.titleNative,
      anime.titleUserPreferred,
      anime.synonymsJson,
      anime.slug,
    ];
    const strings = [
      'Naruto 100%_Hero \\ Path "Quoted"',
      "English café CAFÉ",
      "作品名東京",
      "Preferred-only-title",
      JSON.stringify(["Synonym, One", 'Special "quoted" \\ value', "NARUTO Alt"]),
      "slug-only-needle",
      "punctuation...*** AND OR NOT",
      "🎬🌸日本語🎬🌸",
      "foo\0bar",
      "abc\nxyz\tdef",
    ];
    for (let i = 0; i < strings.length; i++) {
      await db.insert(anime).values({
        titleRomaji: strings[i]!,
        titleEnglish: strings[(i + 1) % strings.length],
        titleNative: strings[(i + 2) % strings.length],
        titleUserPreferred: strings[(i + 3) % strings.length],
        synonymsJson: JSON.stringify([strings[(i + 4) % strings.length]]),
        slug: `record-${i}-${strings[(i + 5) % strings.length]}`,
        format: i % 2 ? "TV" : "MOVIE",
      });
    }
    const queries = [
      "NARUTO",
      "na",
      "%",
      "100%_",
      '"Quoted"',
      "\\ Path",
      "café",
      "CAFÉ",
      "作品名",
      "🎬🌸",
      "日本語",
      "...",
      "AND OR NOT",
      "foo\0bar",
      "does-not-exist",
      '"quoted"',
      ",",
      'e"',
      "abc\nxyz",
    ];
    for (const value of strings) {
      const characters = Array.from(value);
      for (let start = 0; start < characters.length; start += 3) {
        queries.push(characters.slice(start, start + 3 + (start % 5)).join(""));
      }
    }
    for (const q of queries) {
      const search = q.trim();
      if (!search) continue;
      const pattern = `%${escapeLikePattern(search)}%`;
      const literal = sql`(${sql.join(
        fields.map((field) => sql`${field} like ${pattern} escape '\\'`),
        sql` or `,
      )})`;
      for (const format of [undefined, "TV"]) {
        const oracle = await db
          .select({ id: anime.id })
          .from(anime)
          .where(and(literal, format ? eq(anime.format, format) : undefined))
          .orderBy(asc(anime.id));
        const actual = await listAnime({ q, format, sort: "id", limit: 3, offset: 1 });
        expect(actual.total).toBe(oracle.length);
        expect(actual.items.map((row) => row.id)).toEqual(oracle.slice(1, 4).map((row) => row.id));
      }
    }
  });

  test("text updates, deletes and transaction rollbacks keep the index in agreement", async () => {
    const [row] = await db
      .insert(anime)
      .values({ titleRomaji: "Original needle", synonymsJson: '["old synonym"]' })
      .returning();
    const search = (q: string) => listAnime({ q, limit: 50, offset: 0 });
    expect((await search("original")).total).toBe(1);
    await db
      .update(anime)
      .set({ titleRomaji: "Changed needle", synonymsJson: '["new synonym"]' })
      .where(eq(anime.id, row!.id));
    expect((await search("original")).total).toBe(0);
    expect((await search("changed")).total).toBe(1);
    expect((await search("old synonym")).total).toBe(0);
    expect((await search("new synonym")).total).toBe(1);
    await expect(
      db.transaction(async (tx) => {
        await tx.update(anime).set({ titleRomaji: "Rolled back" }).where(eq(anime.id, row!.id));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await search("changed")).total).toBe(1);
    expect((await search("rolled back")).total).toBe(0);
    await db.delete(anime).where(eq(anime.id, row!.id));
    expect((await search("changed")).total).toBe(0);
    await db.run(sql`insert into anime_search(anime_search, rank) values ('integrity-check', 1)`);
  });

  test("migration backfills existing rows and later inserts without changing source text", async () => {
    const directory = dirname(getDatabaseConfig().path);
    if (!directory.includes("anicore-test-")) throw new Error("Expected isolated test database");
    const client = createClient({ url: `file:${join(directory, "search-upgrade.db")}` });
    try {
      await client.executeMultiple(
        await Bun.file(
          new URL("../../../../packages/db/drizzle/0000_init.sql", import.meta.url),
        ).text(),
      );
      await client.execute("insert into anime(title_romaji) values ('Existing needle')");
      await client.executeMultiple(
        await Bun.file(
          new URL("../../../../packages/db/drizzle/0003_catalogue_search.sql", import.meta.url),
        ).text(),
      );
      expect(
        (
          await client.execute(
            `select rowid from anime_search where anime_search match '"existing"'`,
          )
        ).rows,
      ).toHaveLength(1);
      await client.execute("insert into anime(title_romaji) values ('Later needle')");
      expect(
        (await client.execute(`select rowid from anime_search where anime_search match '"needle"'`))
          .rows,
      ).toHaveLength(2);
      expect(
        (await client.execute("select title_romaji from anime order by id")).rows.map(
          (row) => row.title_romaji,
        ),
      ).toEqual(["Existing needle", "Later needle"]);
      await client.execute(
        "insert into anime_search(anime_search, rank) values ('integrity-check', 1)",
      );
    } finally {
      client.close();
    }
  });

  test("deep page hydration preserves order, ties, nulls, filters and totals", async () => {
    for (let start = 0; start < 1200; start += 100) {
      await db.insert(anime).values(
        Array.from({ length: 100 }, (_, offset) => ({
          titleRomaji: `Deep row ${start + offset}`,
          format: "TV",
          averageScore: offset % 10 ? offset % 9 : null,
          popularity: offset % 3 ? offset % 9 : null,
        })),
      );
    }
    for (const column of [
      anime.id,
      anime.averageScore,
      anime.popularity,
      sql`lower(${anime.titleRomaji})`,
    ]) {
      const sort =
        column === anime.id
          ? "id"
          : column === anime.averageScore
            ? "score"
            : column === anime.popularity
              ? "popularity"
              : "title";
      for (const order of ["asc", "desc"] as const) {
        const ordered = sql`${column} ${sql.raw(order)} nulls last`;
        const expected = await db
          .select({ id: anime.id })
          .from(anime)
          .where(eq(anime.format, "TV"))
          .orderBy(ordered, asc(anime.id))
          .limit(20)
          .offset(1001);
        const result = await listAnime({
          format: "TV",
          q: "Deep row",
          sort,
          order,
          limit: 20,
          offset: 1001,
        });
        expect(result.total).toBe(1200);
        expect(result.items.map((row) => row.id)).toEqual(expected.map((row) => row.id));
      }
    }
    expect((await listAnime({ limit: 20, offset: 2000 })).items).toEqual([]);
  });
});
