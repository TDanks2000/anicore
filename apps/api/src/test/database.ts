import { describe } from "bun:test";
import { db, migrateDatabase } from "@anicore/db";
import { sql } from "drizzle-orm";

/**
 * Database integration tests run against the throwaway SQLite file the test
 * preload (`src/test/preload.ts`) points DATABASE_URL at, so they need no
 * external service and run as part of the default `bun test`.
 */
export const describeWithDatabase = describe;

let prepared: Promise<void> | null = null;

async function prepare(): Promise<void> {
  // Defence in depth: the harness wipes every table, so refuse to run unless
  // the preload has redirected DATABASE_URL to its temporary directory.
  if (!process.env.DATABASE_URL?.includes("anicore-test-")) {
    throw new Error(
      `Refusing to run integration tests against "${process.env.DATABASE_URL}": run them through \`bun test\` in apps/api`,
    );
  }
  await migrateDatabase();
}

/** Migrates the test database once per process. */
export function prepareTestDatabase(): Promise<void> {
  prepared ??= prepare();
  return prepared;
}

/** Empties every application table and resets id sequences. */
export async function resetTestDatabase(): Promise<void> {
  await prepareTestDatabase();
  const tables = await db.all<{ name: string }>(sql`
    select name
    from sqlite_master
    where type = 'table'
      and name not glob 'sqlite_*'
      and name <> '__drizzle_migrations'
  `);
  // Every foreign key cascades on delete, so the order does not matter.
  await db.transaction(async (tx) => {
    for (const { name } of tables) await tx.run(sql`delete from ${sql.identifier(name)}`);
    await tx.run(sql`delete from sqlite_sequence`);
  });
}
