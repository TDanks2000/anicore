import { randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateDatabase } from "@anicore/db";
import { getDatabaseConfig } from "@anicore/db/db-config";

async function worker(mode: string, source: string, target?: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("../scripts/database-backup-worker.ts", import.meta.url)),
      mode,
      resolve(source),
      ...(target ? [resolve(target)] : []),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(error.trim() || "Backup worker failed");
  return output;
}

export async function verifyDatabaseBackup(
  path: string,
): Promise<{ animeCount: number; manualOverrides: number }> {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error("Backup file does not exist");
  return JSON.parse(await worker("verify", path));
}

export async function createDatabaseBackup(destination: string): Promise<void> {
  const target = resolve(destination);
  if (existsSync(target)) throw new Error("Backup destination already exists");
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.partial-${randomUUID()}`;
  try {
    // VACUUM INTO creates a consistent SQLite snapshot, including committed WAL data.
    await migrateDatabase();
    await worker("create", getDatabaseConfig().path, temporary);
    await verifyDatabaseBackup(temporary);
    copyFileSync(temporary, target, constants.COPYFILE_EXCL);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Restore to a new file only. Switching the running app to it is an offline operation. */
export async function restoreDatabaseBackup(source: string, destination: string): Promise<void> {
  const target = resolve(destination);
  if (existsSync(target)) throw new Error("Restore destination already exists");
  await verifyDatabaseBackup(source);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(source), target, constants.COPYFILE_EXCL);
  try {
    await verifyDatabaseBackup(target);
  } catch (error) {
    unlinkSync(target);
    throw error;
  }
}
