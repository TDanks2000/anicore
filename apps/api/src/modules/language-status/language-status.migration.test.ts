import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const migrationSql = readFileSync(
  new URL("../../../drizzle/0001_anicore_language_status.sql", import.meta.url),
  "utf8",
);

describe("language status migration", () => {
  test("migrates legacy episode audio rows through anime episode identity", () => {
    expect(migrationSql).toContain('CREATE TABLE "episode_language_status"');
    expect(migrationSql).toContain('FROM "episode_audio_status" eas');
    expect(migrationSql).toContain(
      'INNER JOIN "episodes" e ON e."id" = eas."episode_id"',
    );
    expect(migrationSql).toContain('e."anime_id"');
    expect(migrationSql).toContain('e."number"');
    expect(migrationSql).toContain("'audio' AS \"media_type\"");
  });

  test("maps old unavailable status to episode missing before dropping old table", () => {
    expect(migrationSql).toContain("WHEN 'unavailable' THEN 'missing'");

    const insertIndex = migrationSql.indexOf('INSERT INTO "episode_language_status"');
    const dropIndex = migrationSql.indexOf('DROP TABLE "episode_audio_status"');

    expect(insertIndex).toBeGreaterThan(-1);
    expect(dropIndex).toBeGreaterThan(insertIndex);
  });
});
