import { closeDb } from "@anicore/db";
import { loadIds } from "@anicore/providers/lib/cache";
import { ANILIST_RATE_MS, withAnilistRetry } from "@anicore/providers/lib/anilist-rate-limit";
import { log } from "@anicore/providers/lib/logger";
import { installProxyFetch } from "@anicore/providers/lib/proxy";
import { syncAnilistAnime } from "@anicore/providers/anilist/sync";

installProxyFetch();

async function main(): Promise<void> {
  const ids = await loadIds();
  log.divider();
  log.info(`Starting AniList sync — ${ids.length.toLocaleString()} IDs to process`);
  log.divider();

  let created = 0;
  let updated = 0;
  let failed = 0;
  const errors: Array<{ id: number; error: string }> = [];

  const bar = log.progress(ids.length, "AniList");

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;

    bar.setStage(`ID ${id}`);

    try {
      const result = await withAnilistRetry(() => syncAnilistAnime(id));
      if (result.created) created++;
      else updated++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ id, error: message });
      log.error(`ID ${id}: ${message}`);
    }

    bar.tick().setStats({ created, updated, failed });

    if (i < ids.length - 1) {
      bar.setStage("waiting…");
      await Bun.sleep(ANILIST_RATE_MS);
    }
  }

  bar.finish();
  log.divider();
  log.success(`Sync complete — ${ids.length.toLocaleString()} IDs processed`);
  log.info(`  Created  : ${created.toLocaleString()}`);
  log.info(`  Updated  : ${updated.toLocaleString()}`);
  log.info(`  Failed   : ${failed.toLocaleString()}`);

  if (errors.length > 0) {
    log.divider();
    log.warn("Failed IDs:");
    for (const { id, error } of errors) {
      log.error(`  ${id}: ${error}`);
    }
  }

  log.divider();
}

try {
  await main();
  await closeDb();
} catch (err) {
  log.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  await closeDb().catch(() => undefined);
  process.exit(1);
}
