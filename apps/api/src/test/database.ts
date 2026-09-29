import { describe } from "bun:test";
import { resolve } from "node:path";
import { closeDb, db } from "@anicore/db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

/**
 * Database integration tests run only when TEST_DATABASE_URL is set, so the
 * default `bun test` stays hermetic. CI provides a disposable Postgres.
 *
 * The harness truncates every table between tests, so it refuses to touch a
 * database whose name does not contain "test". Bun loads `.env` automatically,
 * which can point DATABASE_URL at a real database; this guard is what keeps a
 * misconfigured run from wiping it.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

export const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

const migrationsFolder = resolve(import.meta.dir, "../../drizzle");
let prepared: Promise<void> | null = null;

async function prepare(): Promise<void> {
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set");

  // Drop any connection opened against DATABASE_URL before the override.
  await closeDb();
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.ANICORE_DATABASE_SSL ??= "disable";

  const [row] = await db.execute<{ name: string }>(sql`select current_database() as name`);
  if (!row?.name.includes("test")) {
    throw new Error(
      `Refusing to run integration tests against database "${row?.name}": its name must contain "test"`,
    );
  }

  await migrate(db, { migrationsFolder });
}

/** Migrates the test database once per process. */
export function prepareTestDatabase(): Promise<void> {
  prepared ??= prepare();
  return prepared;
}

/** Empties every application table and resets identity sequences. */
export async function resetTestDatabase(): Promise<void> {
  await prepareTestDatabase();
  const tables = await db.execute<{ name: string }>(sql`
    select quote_ident(tablename) as name
    from pg_tables
    where schemaname = 'public'
  `);
  if (tables.length === 0) return;
  const list = [...tables].map((table) => table.name).join(", ");
  await db.execute(sql.raw(`truncate table ${list} restart identity cascade`));
}
