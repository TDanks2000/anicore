import { log } from "../lib/logger";
import { syncAnilistAnime } from "../providers/anilist/sync";

const IDS_URL =
  "https://raw.githubusercontent.com/TDanks2000/anilistIds/refs/heads/main/anime_ids.txt";

// AniList public API: 90 req/min → 2 reqs/ID → min 1333ms. 1500ms is safe.
const RATE_LIMIT_MS = 1500;

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("429") ||
    msg.toLowerCase().includes("rate limit") ||
    msg.toLowerCase().includes("too many requests")
  );
}

async function withAnilistRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err) || attempt === 3) throw err;
      const wait = 60_000 * (attempt + 1);
      log.warn(`Rate limited — waiting ${wait / 1000}s before retry ${attempt + 1}/3…`);
      await Bun.sleep(wait);
    }
  }
  throw new Error("unreachable");
}

log.info("Fetching AniList ID list…");
const text = await fetch(IDS_URL, { signal: AbortSignal.timeout(30_000) }).then((r) => {
  if (!r.ok) throw new Error(`Failed to fetch ID list: ${r.status}`);
  return r.text();
});

const ids = text
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => !isNaN(n) && n > 0);

log.divider();
log.info(`Starting AniList sync — ${ids.length.toLocaleString()} IDs to process`);
log.divider();

let created = 0;
let updated = 0;
let failed  = 0;
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
    await Bun.sleep(RATE_LIMIT_MS);
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
