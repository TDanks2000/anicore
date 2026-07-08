import { sql } from "drizzle-orm";

import { db } from "@anicore/db";
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

const n = sql<number>`count(*)::int`;

async function rowCount(table: Parameters<typeof db.select>[0] extends undefined ? never : any): Promise<number> {
  const [row] = await db.select({ n }).from(table as any);
  return row?.n ?? 0;
}

log.info("Counting rows before wipe…");

const counts = {
  anime:               await rowCount(anime),
  anime_mappings:      await rowCount(animeMappings),
  anime_relation_links:await rowCount(animeRelationLinks),
  studios:             await rowCount(studios),
  anime_studio_links:  await rowCount(animeStudioLinks),
  tags:                await rowCount(tags),
  anime_tag_links:     await rowCount(animeTagLinks),
  anime_external_links:await rowCount(animeExternalLinks),
  anime_language_status:await rowCount(animeLanguageStatus),
  anime_language_evidence:await rowCount(animeLanguageEvidence),
  episodes:            await rowCount(episodes),
  episode_mappings:    await rowCount(episodeMappings),
  episode_language_status:await rowCount(episodeLanguageStatus),
  sync_runs:           await rowCount(syncRuns),
};

const total = Object.values(counts).reduce((a, b) => a + b, 0);

if (total === 0) {
  log.info("Database is already empty — nothing to do.");
  process.exit(0);
}

log.info(`Found ${total.toLocaleString()} rows across ${Object.keys(counts).length} tables.`);
log.warn("Truncating all tables (CASCADE) and resetting sequences…");

await db.execute(sql`
  TRUNCATE
    anime,
    studios,
    tags,
    sync_runs
  RESTART IDENTITY CASCADE
`);

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
