import { closeDb, migrateDatabase } from "@anicore/db";
import { getDatabaseConfig } from "@anicore/db/db-config";
import { log } from "@anicore/providers/lib/logger";

// Migrations also run automatically whenever the database is first opened;
// this is for applying them ahead of time, e.g. after `db:generate`.
const { path } = getDatabaseConfig();
await migrateDatabase();
await closeDb();
log.success(`Database is up to date: ${path}`);
