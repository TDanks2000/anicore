import { integer } from "drizzle-orm/sqlite-core";

/**
 * SQLite stand-ins for the Postgres column types the schema was written with.
 * They keep the TypeScript shapes identical (`number` ids, `boolean` flags,
 * `Date` timestamps) so nothing above the schema has to care about storage.
 */

/** Auto-incrementing primary key. AUTOINCREMENT keeps ids from being reused after deletes. */
export const serial = (name: string) => integer(name).primaryKey({ autoIncrement: true });

/** Stored as 0/1, read back as `boolean`. */
export const boolean = (name: string) => integer(name, { mode: "boolean" });

/** Stored as Unix epoch milliseconds, read back as `Date`. `.defaultNow()` is millisecond precision. */
export const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });
