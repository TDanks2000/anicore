import { type db, readDb } from "@anicore/db";
import type { SQL } from "drizzle-orm";

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs a raw SQL query and returns the rows cast to `T`.
 *
 * `T` is deliberately unconstrained: raw SQL yields a generic row shape, so
 * requiring `T extends Record<string, unknown>` forces every caller to add an
 * index signature to its row interface without adding any real type safety.
 *
 * Rows come straight from SQLite: booleans are 0/1 and timestamps are epoch
 * milliseconds, so row types should say `number` for those columns.
 */
export async function queryRows<T>(query: SQL): Promise<T[]> {
  return readDb.all<T>(query);
}
