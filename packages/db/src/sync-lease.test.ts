import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { sql } from "drizzle-orm";

const dir = mkdtempSync(join(tmpdir(), "anicore-lease-"));
const previousUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = `file:${join(dir, "lease.db")}`;

const { closeDb, db, migrateDatabase, tryAcquireSyncLease } = await import("./index");

/** A pid that is guaranteed to have exited. */
function exitedPid(): number {
  const result = spawnSync(process.execPath, ["--version"]);
  if (!result.pid) throw new Error("could not spawn a helper process");
  return result.pid;
}

async function insertRunning(metadata: Record<string, unknown>): Promise<number> {
  const [row] = await db.all<{ id: number }>(sql`
    INSERT INTO sync_runs (provider, kind, status, metadata_json)
    VALUES ('anilist', 'full', 'running', ${JSON.stringify(metadata)})
    RETURNING id
  `);
  return row!.id;
}

async function statusOf(id: number): Promise<string> {
  const [row] = await db.all<{ status: string }>(
    sql`SELECT status FROM sync_runs WHERE id = ${id}`,
  );
  return row!.status;
}

async function clearRuns(): Promise<void> {
  await db.run(sql`DELETE FROM sync_runs`);
}

describe("tryAcquireSyncLease", () => {
  beforeAll(async () => {
    await migrateDatabase();
  });

  afterAll(async () => {
    await closeDb();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can keep the SQLite file locked briefly after close; the OS temp dir cleans up.
    }
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  });

  test("recovers a lease whose owning process has exited, without waiting for the heartbeat timeout", async () => {
    await clearRuns();
    const deadId = await insertRunning({ heartbeatAt: Date.now(), pid: exitedPid() });

    const lease = await tryAcquireSyncLease();

    expect(lease).not.toBeNull();
    expect(await statusOf(deadId)).toBe("failed");
    await lease?.release();
  });

  test("refuses while the owning process is still alive and heartbeating", async () => {
    await clearRuns();
    // The parent process is a live pid other than this one.
    const liveId = await insertRunning({ heartbeatAt: Date.now(), pid: process.ppid });

    expect(await tryAcquireSyncLease()).toBeNull();
    expect(await statusOf(liveId)).toBe("running");
  });

  test("falls back to the heartbeat timeout for leases without a pid", async () => {
    await clearRuns();
    const freshId = await insertRunning({ heartbeatAt: Date.now() });
    expect(await tryAcquireSyncLease()).toBeNull();
    expect(await statusOf(freshId)).toBe("running");

    await clearRuns();
    const staleId = await insertRunning({ heartbeatAt: Date.now() - 6 * 60_000 });
    const lease = await tryAcquireSyncLease();
    expect(lease).not.toBeNull();
    expect(await statusOf(staleId)).toBe("failed");
    await lease?.release();
  });
});
