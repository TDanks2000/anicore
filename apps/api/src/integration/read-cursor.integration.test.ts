import { beforeEach, expect, test } from "bun:test";
import { db, readDb } from "@anicore/db";
import { anime } from "@anicore/db/schema";
import { sql } from "drizzle-orm";
import { app } from "../app";
import { listAnime } from "../modules/anime/anime.service";
import { describeWithDatabase, resetTestDatabase } from "../test/database";

describeWithDatabase("independent reads and additive catalogue options", () => {
  beforeEach(resetTestDatabase);
  test("revision changes for writes and language updates, but not rollbacks", async () => {
    const revision = async () =>
      (await (await app.handle(new Request("http://localhost/anime/revision"))).json())
        .revision as number;
    const before = await revision();
    const [row] = await db.insert(anime).values({ titleRomaji: "Revision" }).returning();
    const inserted = await revision();
    expect(inserted).toBeGreaterThan(before);
    await expect(
      db.transaction(async (tx) => {
        await tx.run(sql`update anime set title_romaji='Rolled back' where id=${row!.id}`);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await revision()).toBe(inserted);
    await db.run(
      sql`insert into anime_language_status(anime_id,language_code,media_type,status,is_manual_override) values(${row!.id},'en','audio','confirmed',1)`,
    );
    expect(await revision()).toBeGreaterThan(inserted);
    const response = await app.handle(
      new Request("http://localhost/anime?limit=1&projection=summary&pagination=cursor&sort=id"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-next-cursor")).toBe("");
    expect((await response.json())[0]).not.toHaveProperty("description");
  });
  test("read connection sees committed data without waiting behind an open writer", async () => {
    await db.insert(anime).values({ titleRomaji: "Committed" });
    await readDb.select().from(anime);
    let ready!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = db.transaction(async (tx) => {
      await tx.insert(anime).values({ titleRomaji: "Uncommitted" });
      ready();
      await gate;
    });
    await started;
    try {
      const result = await Promise.race([
        readDb.select().from(anime),
        Bun.sleep(1000).then(() => {
          throw new Error("Read blocked behind writer");
        }),
      ]);
      expect(result.map((row) => row.titleRomaji)).toEqual(["Committed"]);
    } finally {
      release();
      await writer;
    }
    expect(await readDb.select().from(anime)).toHaveLength(2);
    await expect(Promise.resolve(readDb.run(sql`delete from anime`))).rejects.toThrow();
    expect(await readDb.select().from(anime)).toHaveLength(2);
  });
  test("cursor pages preserve full totals and summary excludes large fields", async () => {
    await db.insert(anime).values(
      Array.from({ length: 5 }, (_, id) => ({
        titleRomaji: `Title ${id}`,
        description: "Large synopsis",
        format: "TV",
      })),
    );
    for (const order of ["asc", "desc"] as const) {
      const first = await listAnime({
        limit: 2,
        offset: 0,
        pagination: "cursor",
        sort: "id",
        order,
        projection: "summary",
      });
      expect(first.total).toBe(5);
      expect(first.items[0]).not.toHaveProperty("description");
      const second = await listAnime({
        limit: 2,
        offset: 0,
        pagination: "cursor",
        sort: "id",
        order,
        afterId: first.nextCursor!,
      });
      const third = await listAnime({
        limit: 2,
        offset: 0,
        pagination: "cursor",
        sort: "id",
        order,
        afterId: second.nextCursor!,
      });
      expect(second.total).toBe(5);
      expect(third.nextCursor).toBeNull();
      const ids = [...first.items, ...second.items, ...third.items].map((row) => row.id);
      expect(ids).toEqual(order === "asc" ? [1, 2, 3, 4, 5] : [5, 4, 3, 2, 1]);
    }
    expect((await listAnime({ limit: 1, offset: 0 })).items[0]).toHaveProperty(
      "description",
      "Large synopsis",
    );
    await expect(listAnime({ limit: 1, offset: 2, pagination: "cursor" })).rejects.toThrow(
      "offset=0",
    );
    await expect(
      listAnime({ limit: 1, offset: 0, pagination: "cursor", sort: "score" }),
    ).rejects.toThrow("id sorting");
  });
});
