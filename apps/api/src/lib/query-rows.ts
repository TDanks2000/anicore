import { type SQL } from "drizzle-orm";

import { db } from "@anicore/db";

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs a raw SQL query and returns the rows cast to `T`.
 *
 * `T` is deliberately unconstrained: `db.execute` yields a generic row shape, so
 * requiring `T extends Record<string, unknown>` forces every caller to add an
 * index signature to its row interface without adding any real type safety.
 */
export async function queryRows<T>(query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return [...result] as unknown as T[];
}

/** Transaction-scoped counterpart to {@link queryRows}. */
export async function transactionRows<T>(
  tx: DbTransaction,
  query: SQL,
): Promise<T[]> {
  const result = await tx.execute(query);
  return [...result] as unknown as T[];
}
