import { closeDb } from "@anicore/db";
import {
  createDatabaseBackup,
  restoreDatabaseBackup,
  verifyDatabaseBackup,
} from "../lib/database-backup";

if (import.meta.main) {
  try {
    const [command, source, target, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error("Unexpected backup arguments");
    if (command === "create" && source && !target) await createDatabaseBackup(source);
    else if (command === "verify" && source && !target) await verifyDatabaseBackup(source);
    else if (command === "restore" && source && target) await restoreDatabaseBackup(source, target);
    else
      throw new Error(
        "Usage: database-backup.ts create <new-file> | verify <backup> | restore <backup> <new-file>",
      );
    console.log("Database backup operation completed and verified");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
