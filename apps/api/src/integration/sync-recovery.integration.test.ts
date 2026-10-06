import { beforeEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { db } from "@anicore/db";
import { anime, syncStageState } from "@anicore/db/schema";
import { hasFailedStages, refreshTtl, runSyncStage } from "@anicore/providers/lib/stage-state";
import { eq, sql } from "drizzle-orm";
import {
  createDatabaseBackup,
  restoreDatabaseBackup,
  verifyDatabaseBackup,
} from "../lib/database-backup";
import { auditLanguageStatus } from "../scripts/audit-language-status";
import { auditMappings } from "../scripts/audit-mappings";
import { describeWithDatabase, resetTestDatabase } from "../test/database";

describeWithDatabase("durable stage freshness and recovery", () => {
  beforeEach(resetTestDatabase);
  test("scheduled audit implementations operate through independent reads", async () => {
    expect((await auditMappings()).ok).toBe(true);
    expect((await auditLanguageStatus()).ok).toBe(true);
  });
  test("successful work persists across retries and failures have cooldowns", async () => {
    let completed = 0;
    let attempts = 0;
    const success = () =>
      runSyncStage(123, "provider:a", 3600_000, async () => ({ count: ++completed }));
    expect(await success()).toEqual({ count: 1 });
    await expect(
      runSyncStage(123, "provider:b", 3600_000, async () => {
        attempts++;
        throw new Error("Provider offline");
      }),
    ).rejects.toThrow("Provider offline");
    expect(await hasFailedStages(123)).toBe(true);
    expect(await success()).toEqual({ count: 1 });
    await expect(
      runSyncStage(123, "provider:b", 3600_000, async () => {
        attempts++;
        return true;
      }),
    ).rejects.toThrow("cooling down");
    expect(attempts).toBe(1);
    await db
      .update(syncStageState)
      .set({ retryAt: 0 })
      .where(eq(syncStageState.key, "123:provider:b"));
    expect(await runSyncStage(123, "provider:b", 3600_000, async () => true)).toBe(true);
    expect(await hasFailedStages(123)).toBe(false);
    expect(completed).toBe(1);
    expect(refreshTtl("FINISHED", true)).toBeLessThan(refreshTtl("FINISHED"));
    expect(refreshTtl("RELEASING")).toBeLessThan(refreshTtl("FINISHED"));
  });
  test("coalesces duplicate in-flight work and independently expires stages", async () => {
    let calls = 0;
    const op = async () => {
      calls++;
      await Bun.sleep(10);
      return 7;
    };
    expect(
      await Promise.all([
        runSyncStage(456, "metadata", 1000, op),
        runSyncStage(456, "metadata", 1000, op),
      ]),
    ).toEqual([7, 7]);
    expect(calls).toBe(1);
    await db
      .update(syncStageState)
      .set({ nextDueAt: 0 })
      .where(eq(syncStageState.key, "456:metadata"));
    await runSyncStage(456, "metadata", 1000, op);
    expect(calls).toBe(2);
  });
  test("caches confirmed missing sources with result-specific TTL and repairs malformed snapshots", async () => {
    let calls = 0;
    const lifetime = 30 * 24 * 3600_000;
    const fetchMissing = () =>
      runSyncStage(
        789,
        "anilist-fetch",
        (value) => (value === null ? lifetime : 1000),
        async () => {
          calls++;
          return null;
        },
      );
    expect(await fetchMissing()).toBeNull();
    expect(await fetchMissing()).toBeNull();
    expect(calls).toBe(1);
    const state = await db
      .select()
      .from(syncStageState)
      .where(eq(syncStageState.key, "789:anilist-fetch"));
    expect(state[0]!.nextDueAt! - state[0]!.successAt!).toBe(lifetime);
    await db
      .update(syncStageState)
      .set({ payloadJson: "malformed" })
      .where(eq(syncStageState.key, "789:anilist-fetch"));
    expect(await fetchMissing()).toBeNull();
    expect(calls).toBe(2);
  });
  test("backup and restore preserve committed WAL content and search integrity", async () => {
    const root = dirname(process.env.DATABASE_URL!);
    const backup = join(root, "snapshot.db");
    const restored = join(root, "restored.db");
    await db
      .insert(anime)
      .values({ titleRomaji: "Backup needle", description: "Preserve synopsis" });
    await db.run(
      sql`insert into anime_language_status(anime_id,language_code,media_type,status,is_manual_override) values(1,'en','audio','confirmed',1)`,
    );
    await createDatabaseBackup(backup);
    await db.insert(anime).values({ titleRomaji: "After snapshot" });
    await restoreDatabaseBackup(backup, restored);
    expect((await verifyDatabaseBackup(restored)).animeCount).toBe(1);
    expect((await verifyDatabaseBackup(restored)).manualOverrides).toBe(1);
    await expect(createDatabaseBackup(backup)).rejects.toThrow("already exists");
    await expect(restoreDatabaseBackup(backup, restored)).rejects.toThrow("already exists");
    expect(await db.all(sql`select id from anime`)).toHaveLength(2);
  });
});
