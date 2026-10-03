import { closeDb } from "@anicore/db";
import { getDatabaseConfig } from "@anicore/db/db-config";
import { analyzeDbShape } from "@anicore/db/db-shape";
import { log } from "@anicore/providers/lib/logger";
import { sql } from "drizzle-orm";
import { queryRows } from "../lib/query-rows";

interface TableRow {
  tableName: string;
}

interface IndexRow {
  tableName: string;
  indexName: string;
}

interface CountRow {
  count: number;
}

const MIGRATIONS_TABLE = "__drizzle_migrations";

try {
  log.info(`Database: ${getDatabaseConfig().path}`);
} catch (err) {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

try {
  const tableRows = await queryRows<TableRow>(sql`
    select name as "tableName"
    from sqlite_master
    where type = 'table'
      and name not glob 'sqlite_*'
    order by name
  `);

  const indexRows = await queryRows<IndexRow>(sql`
    select tbl_name as "tableName", name as "indexName"
    from sqlite_master
    where type = 'index'
    order by tbl_name, name
  `);

  const report = analyzeDbShape(tableRows, indexRows);
  const hasMigrationTable = tableRows.some((row) => row.tableName === MIGRATIONS_TABLE);
  let migrationHistoryReadable = hasMigrationTable;

  log.divider();
  log.info("AniCore DB shape check");
  log.divider();

  log.info(`Expected tables present: ${report.expectedTablesPresent.length}`);
  for (const tableName of report.expectedTablesPresent) {
    log.success(`table present: ${tableName}`);
  }

  if (report.missingTables.length) {
    for (const tableName of report.missingTables) {
      log.error(`missing expected table: ${tableName}`);
    }
  }

  if (report.presentLegacyTables.length) {
    for (const tableName of report.presentLegacyTables) {
      log.error(`legacy table still present: ${tableName}`);
    }
  } else {
    log.success("legacy tables absent: anime_studios, anime_tags");
  }

  log.info(`Expected indexes present: ${report.expectedIndexesPresent.length}`);
  for (const { tableName, indexName } of report.expectedIndexesPresent) {
    log.success(`index present: ${tableName}.${indexName}`);
  }

  if (report.missingIndexes.length) {
    for (const { tableName, indexName } of report.missingIndexes) {
      log.error(`missing expected index: ${tableName}.${indexName}`);
    }
  }

  if (!hasMigrationTable) {
    log.error(`Drizzle migration table missing: ${MIGRATIONS_TABLE}`);
  } else {
    try {
      const [countRow] = await queryRows<CountRow>(
        sql`select count(*) as "count" from ${sql.identifier(MIGRATIONS_TABLE)}`,
      );
      log.success(
        `Drizzle migration table present: ${MIGRATIONS_TABLE} (${countRow?.count ?? 0} rows)`,
      );
    } catch (err) {
      migrationHistoryReadable = false;
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Drizzle migration table present but unreadable: ${MIGRATIONS_TABLE} (${message})`);
    }
  }

  log.divider();

  if (!report.ok || !migrationHistoryReadable) {
    log.error("DB shape does not match the normalized AniCore schema.");
    process.exit(1);
  }

  log.success("DB shape matches the normalized AniCore schema.");
} finally {
  await closeDb();
}
