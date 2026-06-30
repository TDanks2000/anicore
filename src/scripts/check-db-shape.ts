import postgres from "postgres";

import { analyzeDbShape } from "../lib/db-shape";
import { getDatabaseConfig } from "../lib/db-config";
import { log } from "../lib/logger";

interface TableRow {
  tableSchema: string;
  tableName: string;
}

interface IndexRow {
  tableName: string;
  indexName: string;
}

interface MigrationTableRow {
  tableSchema: string;
  tableName: string;
}

interface CountRow {
  count: number;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

const databaseConfig = (() => {
  try {
    return getDatabaseConfig();
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
})();

const sql = postgres(databaseConfig.url, {
  max: 1,
  ssl: databaseConfig.ssl,
});

try {
  const tableRows = await sql<TableRow[]>`
    select table_schema as "tableSchema", table_name as "tableName"
    from information_schema.tables
    where table_schema = 'public'
      and table_type = 'BASE TABLE'
    order by table_name
  `;

  const indexRows = await sql<IndexRow[]>`
    select tablename as "tableName", indexname as "indexName"
    from pg_indexes
    where schemaname = 'public'
    order by tablename, indexname
  `;

  const migrationTables = await sql<MigrationTableRow[]>`
    select table_schema as "tableSchema", table_name as "tableName"
    from information_schema.tables
    where table_name = '__drizzle_migrations'
      and table_type = 'BASE TABLE'
    order by table_schema, table_name
  `;

  const report = analyzeDbShape(tableRows, indexRows);
  let migrationHistoryReadable = migrationTables.length > 0;

  log.divider();
  log.info("AniCore DB shape check");
  log.divider();

  log.info(
    `Expected tables present: ${report.expectedTablesPresent.length}`,
  );
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

  log.info(
    `Expected indexes present: ${report.expectedIndexesPresent.length}`,
  );
  for (const { tableName, indexName } of report.expectedIndexesPresent) {
    log.success(`index present: ${tableName}.${indexName}`);
  }

  if (report.missingIndexes.length) {
    for (const { tableName, indexName } of report.missingIndexes) {
      log.error(`missing expected index: ${tableName}.${indexName}`);
    }
  }

  if (migrationTables.length === 0) {
    log.error("Drizzle migration table missing: __drizzle_migrations");
  } else {
    for (const table of migrationTables) {
      const qualifiedName = `${quoteIdentifier(table.tableSchema)}.${quoteIdentifier(table.tableName)}`;
      try {
        const [countRow] = await sql.unsafe<CountRow[]>(
          `select count(*)::int as "count" from ${qualifiedName}`,
        );
        log.success(
          `Drizzle migration table present: ${table.tableSchema}.${table.tableName} (${countRow?.count ?? 0} rows)`,
        );
      } catch (err) {
        migrationHistoryReadable = false;
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          `Drizzle migration table present but unreadable: ${table.tableSchema}.${table.tableName} (${message})`,
        );
      }
    }
  }

  log.divider();

  if (!report.ok || migrationTables.length === 0 || !migrationHistoryReadable) {
    log.error("DB shape does not match the normalized AniCore schema.");
    process.exit(1);
  }

  log.success("DB shape matches the normalized AniCore schema.");
} finally {
  await sql.end();
}
