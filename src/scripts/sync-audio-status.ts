import { and, eq, isNotNull, lte, sql } from "drizzle-orm";

import { db } from "../db";
import { anime, animeMappings, episodeAudioStatus, episodes } from "../db/schema";
import { log } from "../lib/logger";
import { syncDubStatus, sleep } from "../providers/animeschedule/sync";

const args      = process.argv.slice(2);
const SUB_ONLY  = args.includes("--sub-only");
const DUB_ONLY  = args.includes("--dub-only");
const FROM_INDEX = parseInt(
  args.find((a) => a.startsWith("--from="))?.slice(7) ?? "0",
  10,
);

const RUN_SUB = !DUB_ONLY;
const RUN_DUB = !SUB_ONLY;

export async function syncSubStatusForAnime(animeId: number): Promise<number> {
  const today = new Date().toISOString().split("T")[0]!;
  const rows = await db
    .select({ id: episodes.id })
    .from(episodes)
    .where(
      and(
        eq(episodes.animeId, animeId),
        isNotNull(episodes.airDate),
        lte(episodes.airDate, today),
      ),
    );

  if (!rows.length) return 0;

  await db
    .insert(episodeAudioStatus)
    .values(
      rows.flatMap((ep) => [
        {
          episodeId: ep.id,
          audioMode: "original" as const,
          locale: "ja",
          status: "available" as const,
          sourceProvider: "derived-airdate",
          checkedAt: new Date(),
        },
        {
          episodeId: ep.id,
          audioMode: "sub" as const,
          locale: "en",
          status: "available" as const,
          sourceProvider: "derived-airdate",
          checkedAt: new Date(),
        },
      ]),
    )
    .onConflictDoNothing();

  return rows.length;
}

export async function syncDubStatusForAnime(animeId: number): Promise<void> {
  const [row] = await db
    .select({
      animeId: animeMappings.animeId,
      anilistId: animeMappings.providerId,
      slug: anime.slug,
      titleRomaji: anime.titleRomaji,
      titleEnglish: anime.titleEnglish,
    })
    .from(animeMappings)
    .innerJoin(anime, eq(animeMappings.animeId, anime.id))
    .where(
      and(
        eq(animeMappings.provider, "anilist"),
        eq(animeMappings.animeId, animeId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new Error(`AniList mapping not found for anime ${animeId}`);
  }

  await syncDubStatus({
    animeId: row.animeId,
    anilistId: row.anilistId,
    slug: row.slug,
    titleRomaji: row.titleRomaji,
    titleEnglish: row.titleEnglish ?? null,
  });
}

// ── Pass 1: Sub ───────────────────────────────────────────────────────────────

export async function runSubPass(): Promise<void> {
  log.divider();
  log.info("Sub pass — marking sub=available for all episodes with a past air_date…");

  const today    = new Date().toISOString().split("T")[0]!;
  const BATCH    = 5_000;
  const CHUNK    = 1_000;
  let offset     = 0;
  let processed  = 0;

  // Count total so the bar can show a meaningful total
  const [countRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(episodes)
    .where(and(isNotNull(episodes.airDate), lte(episodes.airDate, today)));
  const total = countRow?.n ?? 0;

  log.info(`${total.toLocaleString()} aired episodes to process`);

  const bar = log.progress(total, "Sub");
  const checkedAt = new Date();

  while (true) {
    const rows = await db
      .select({ id: episodes.id })
      .from(episodes)
      .where(and(isNotNull(episodes.airDate), lte(episodes.airDate, today)))
      .limit(BATCH)
      .offset(offset);

    if (!rows.length) break;

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await db
        .insert(episodeAudioStatus)
        .values(
          chunk.flatMap((ep) => [
            {
              episodeId:      ep.id,
              audioMode:      "original" as const,
              locale:         "ja",
              status:         "available" as const,
              sourceProvider: "derived-airdate",
              checkedAt,
            },
            {
              episodeId:      ep.id,
              audioMode:      "sub" as const,
              locale:         "en",
              status:         "available" as const,
              sourceProvider: "derived-airdate",
              checkedAt,
            },
          ]),
        )
        .onConflictDoNothing();

      processed += chunk.length;
      bar.tick(chunk.length).setStats({ processed });
    }

    offset += BATCH;
    if (rows.length < BATCH) break;
  }

  bar.finish();
  log.success(`Sub pass complete — ${processed.toLocaleString()} episodes processed.`);
}

// ── Pass 2: Dub ───────────────────────────────────────────────────────────────

export async function runDubPass(): Promise<void> {
  log.divider();
  log.info("Dub pass — fetching dub status from anime-schedule.net…");

  const rows = await db
    .select({
      animeId:      animeMappings.animeId,
      anilistId:    animeMappings.providerId,
      slug:         anime.slug,
      titleRomaji:  anime.titleRomaji,
      titleEnglish: anime.titleEnglish,
    })
    .from(animeMappings)
    .innerJoin(anime, eq(animeMappings.animeId, anime.id))
    .where(eq(animeMappings.provider, "anilist"));

  const total = rows.length;
  log.info(`${total.toLocaleString()} anime to process (starting at index ${FROM_INDEX})`);

  let fullyDubbed = 0;
  let noDub       = 0;
  let ongoingDub  = 0;
  let unmatched   = 0;
  let errors      = 0;
  let noEpisodes  = 0;

  const bar = log.progress(total - FROM_INDEX, "Dub");

  for (let i = FROM_INDEX; i < rows.length; i++) {
    const row = rows[i]!;

    bar.setStage(row.titleEnglish ?? row.titleRomaji ?? String(row.anilistId));

    try {
      const result = await syncDubStatus({
        animeId:      row.animeId,
        anilistId:    row.anilistId,
        slug:         row.slug,
        titleRomaji:  row.titleRomaji,
        titleEnglish: row.titleEnglish ?? null,
      });

      switch (result.status) {
        case "matched-fully-dubbed":  fullyDubbed++; break;
        case "matched-no-dub":        noDub++;       break;
        case "matched-ongoing-dub":   ongoingDub++;  break;
        case "unmatched":             unmatched++;   break;
        case "no-episodes":           noEpisodes++;  break;
      }
    } catch (err) {
      errors++;
      log.error(`animeId=${row.animeId} anilist=${row.anilistId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    bar.tick().setStats({ dubbed: fullyDubbed, noDub, ongoing: ongoingDub, errors });
  }

  bar.finish();
  log.divider();
  log.success("Dub pass complete.");
  log.info(`  Fully dubbed     : ${fullyDubbed.toLocaleString()}`);
  log.info(`  No dub           : ${noDub.toLocaleString()}`);
  log.info(`  Ongoing dub      : ${ongoingDub.toLocaleString()} (skipped — needs API token)`);
  log.info(`  Unmatched        : ${unmatched.toLocaleString()}`);
  log.info(`  No episodes yet  : ${noEpisodes.toLocaleString()}`);
  log.info(`  Errors           : ${errors.toLocaleString()}`);
  log.divider();
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  if (RUN_SUB) await runSubPass();
  if (RUN_DUB) await runDubPass();
  log.success("Done.");
}
