import { db } from "@anicore/db";
import { animeMappings, syncStageState } from "@anicore/db/schema";
import { and, eq, gt } from "drizzle-orm";

/** IDs that cannot add an anime: mapped already, or confirmed missing until their TTL expires. */
export async function loadNewSyncExcludedIds(
  reconcile = false,
  now = Date.now(),
): Promise<Set<number>> {
  const mapped = await db
    .select({ id: animeMappings.providerId })
    .from(animeMappings)
    .where(eq(animeMappings.provider, "anilist"));
  const excluded = new Set(mapped.map((row) => Number(row.id)));

  // Reconciliation explicitly forces source requests, including cached 404s.
  if (!reconcile) {
    const missing = await db
      .select({ id: syncStageState.anilistId })
      .from(syncStageState)
      .where(
        and(
          eq(syncStageState.stage, "anilist-fetch"),
          eq(syncStageState.payloadJson, "null"),
          eq(syncStageState.failures, 0),
          gt(syncStageState.nextDueAt, now),
        ),
      );
    for (const row of missing) excluded.add(row.id);
  }

  return excluded;
}
