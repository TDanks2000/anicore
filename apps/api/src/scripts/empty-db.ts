import { db } from "@anicore/db";
import { animeProviderMappings, animeProviderSegments } from "@anicore/db/provider-mapping-schema";
import {
  anime,
  animeExternalLinks,
  animeLanguageEvidence,
  animeLanguageStatus,
  animeMappings,
  animeRelationLinks,
  animeStudioLinks,
  animeTagLinks,
  episodeLanguageStatus,
  episodeMappings,
  episodes,
  studios,
  syncRuns,
  tags,
} from "@anicore/db/schema";
import { clearAllUnmatched, resetProgress } from "@anicore/providers/lib/cache";
import { log } from "@anicore/providers/lib/logger";
import { getTableName, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

const n = sql<number>`count(*)`;

async function rowCount(table: SQLiteTable): Promise<number> {
  const [row] = await db.select({ n }).from(table);
  return row?.n ?? 0;
}

log.info("Counting rows before wipe…");

const counts = {
  anime: await rowCount(anime),
  anime_mappings: await rowCount(animeMappings),
  anime_relation_links: await rowCount(animeRelationLinks),
  studios: await rowCount(studios),
  anime_studio_links: await rowCount(animeStudioLinks),
  tags: await rowCount(tags),
  anime_tag_links: await rowCount(animeTagLinks),
  anime_external_links: await rowCount(animeExternalLinks),
  anime_language_status: await rowCount(animeLanguageStatus),
  anime_language_evidence: await rowCount(animeLanguageEvidence),
  episodes: await rowCount(episodes),
  episode_mappings: await rowCount(episodeMappings),
  episode_language_status: await rowCount(episodeLanguageStatus),
  sync_runs: await rowCount(syncRuns),
};

const total = Object.values(counts).reduce((a, b) => a + b, 0);

if (total === 0) {
  log.info("Database is already empty — nothing to do.");
  process.exit(0);
}

log.info(`Found ${total.toLocaleString()} rows across ${Object.keys(counts).length} tables.`);
log.warn("Deleting all rows and resetting id sequences…");

// Children before parents. provider_entities is kept: it is shared provider
// identity, not per-anime data, matching the old TRUNCATE ... CASCADE scope.
const wipeOrder: SQLiteTable[] = [
  animeProviderSegments,
  animeProviderMappings,
  episodeLanguageStatus,
  episodeMappings,
  episodes,
  animeLanguageEvidence,
  animeLanguageStatus,
  animeExternalLinks,
  animeTagLinks,
  animeStudioLinks,
  animeRelationLinks,
  animeMappings,
  anime,
  tags,
  studios,
  syncRuns,
];

await db.transaction(async (tx) => {
  for (const table of wipeOrder) await tx.delete(table);
  const names = wipeOrder.map((table) => getTableName(table));
  await tx.run(
    sql`delete from sqlite_sequence where name in (${sql.join(
      names.map((name) => sql`${name}`),
      sql`, `,
    )})`,
  );
});

log.info("Resetting progress cache and unmatched files…");
await resetProgress();
clearAllUnmatched();

log.divider();
log.success("Database emptied. Rows removed:");

const maxLen = Math.max(...Object.keys(counts).map((k) => k.length));
for (const [name, count] of Object.entries(counts)) {
  if (count > 0) {
    log.info(`  ${name.padEnd(maxLen + 2)} ${count.toLocaleString()}`);
  }
}

log.divider();
log.success(`Wiped ${total.toLocaleString()} rows total. Ready for a fresh sync.`);
