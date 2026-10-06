import { db, readDb } from "@anicore/db";
import { syncStageState } from "@anicore/db/schema";
import { and, eq, gt } from "drizzle-orm";

const flights = new Map<string, Promise<unknown>>();
export const refreshTtl = (status: string | null | undefined, language = false): number =>
  status === "FINISHED" || status === "CANCELLED"
    ? (language ? 24 : 7 * 24) * 3600_000
    : 6 * 3600_000;

export async function hasFailedStages(id: number): Promise<boolean> {
  return (
    (
      await readDb
        .select({ key: syncStageState.key })
        .from(syncStageState)
        .where(and(eq(syncStageState.anilistId, id), gt(syncStageState.failures, 0)))
        .limit(1)
    ).length > 0
  );
}

export async function readStage(id: number, stage: string) {
  return (
    await readDb
      .select()
      .from(syncStageState)
      .where(eq(syncStageState.key, `${id}:${stage}`))
      .limit(1)
  )[0];
}

/** Successful stages survive a later failure; only due/failed stages run again. */
export function runSyncStage<T>(
  id: number,
  stage: string,
  ttlMs: number | ((value: T) => number),
  operation: () => Promise<T>,
  force = false,
): Promise<T> {
  const key = `${id}:${stage}`;
  const existing = flights.get(key);
  if (existing) return existing as Promise<T>;
  const run = (async () => {
    const state = await readStage(id, stage);
    const now = Date.now();
    if (
      !force &&
      state &&
      state.failures === 0 &&
      state.nextDueAt !== null &&
      state.nextDueAt > now &&
      state.payloadJson !== null
    ) {
      try {
        return JSON.parse(state.payloadJson) as T;
      } catch {
        /* Treat an invalid cached snapshot as stale and rebuild it. */
      }
    }
    if (!force && state?.failures && state.retryAt !== null && state.retryAt > now) {
      throw new Error(`${stage} retry cooling down until ${new Date(state.retryAt).toISOString()}`);
    }
    try {
      const value = await operation();
      const lifetime = typeof ttlMs === "function" ? ttlMs(value) : ttlMs;
      const completed = Date.now();
      await db
        .insert(syncStageState)
        .values({
          key,
          anilistId: id,
          stage,
          attemptedAt: now,
          successAt: completed,
          nextDueAt: completed + lifetime,
          failures: 0,
          retryAt: null,
          error: null,
          payloadJson: JSON.stringify(value ?? null),
        })
        .onConflictDoUpdate({
          target: syncStageState.key,
          set: {
            attemptedAt: now,
            successAt: completed,
            nextDueAt: completed + lifetime,
            failures: 0,
            retryAt: null,
            error: null,
            payloadJson: JSON.stringify(value ?? null),
          },
        });
      return value;
    } catch (error) {
      const failures = (state?.failures ?? 0) + 1;
      const retryAt = Date.now() + Math.min(3600_000, 60_000 * 2 ** Math.min(failures - 1, 10));
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      await db
        .insert(syncStageState)
        .values({ key, anilistId: id, stage, attemptedAt: now, failures, retryAt, error: message })
        .onConflictDoUpdate({
          target: syncStageState.key,
          set: { attemptedAt: now, failures, retryAt, error: message },
        });
      throw error;
    }
  })();
  flights.set(key, run);
  void run.finally(() => flights.delete(key)).catch(() => {});
  return run;
}
