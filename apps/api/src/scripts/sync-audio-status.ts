import { and, eq, isNotNull, lte, sql } from "drizzle-orm";

import { closeDb, db } from "@anicore/db";
import { syncAnimeLanguageEvidenceFromEpisodeStatuses } from "@anicore/db/language-status";
import { anime, animeMappings, episodeLanguageStatus, episodes } from "@anicore/db/schema";
import { log } from "@anicore/providers/lib/logger";
import { installProxyFetch } from "@anicore/providers/lib/proxy";
import { syncDubStatus, sleep } from "@anicore/providers/animeschedule/sync";
import { derivedAirdateLanguageAssertions } from "../lib/derived-airdate-language";

const args      = process.argv.slice(2);
const SUB_ONLY  = args.includes("--sub-only");
const DUB_ONLY  = args.includes("--dub-only");
const FROM_INDEX = parseInt(
  args.find((a) => a.startsWith("--from="))?.slice(7) ?? "0",
  10,
);

const RUN_SUB = !DUB_ONLY;
const RUN_DUB = !SUB_ONLY;
const DERIVED_AIRDATE_PROVIDER = "derived-airdate";

async function recalculateDerivedAirdateEvidence(animeId: number): Promise<void> {
  // Recalculate both shapes so upgrading from the old heuristic also removes
  // its legacy English-subtitle evidence.
  await syncAnimeLanguageEvidenceFromEpisodeStatuses({
    animeId,
    languageCode: "ja",
    mediaType: "audio",
    provider: DERIVED_AIRDATE_PROVIDER,
  });
  await syncAnimeLanguageEvidenceFromEpisodeStatuses({
    animeId,
    languageCode: "en",
    mediaType: "subtitle",
    provider: DERIVED_AIRDATE_PROVIDER,
  });
}

export async function syncSubStatusForAnime(animeId: number): Promise<number> {
  const [animeRow] = await db
    .select({ countryOfOrigin: anime.countryOfOrigin })
    .from(anime)
    .where(eq(anime.id, animeId))
    .limit(1);
  if (!animeRow) throw new Error(`Anime ${animeId} not found`);

  const today = new Date().toISOString().split("T")[0]!;
  const rows = await db
    .select({ number: episodes.number })
    .from(episodes)
    .where(
      and(
        eq(episodes.animeId, animeId),
        isNotNull(episodes.airDate),
        lte(episodes.airDate, today),
      ),
    );
  const assertions = derivedAirdateLanguageAssertions(animeRow.countryOfOrigin);
  const checkedAt = new Date();

  // Derived evidence is cheap to rebuild and has no field-level provenance to
  // merge. Replace this provider's snapshot transactionally so corrected air
  // dates or country metadata withdraw stale rows instead of accumulating them.
  await db.transaction(async (tx) => {
    await tx
      .delete(episodeLanguageStatus)
      .where(
        and(
          eq(episodeLanguageStatus.animeId, animeId),
          eq(episodeLanguageStatus.provider, DERIVED_AIRDATE_PROVIDER),
        ),
      );

    if (!rows.length || !assertions.length) return;
    await tx.insert(episodeLanguageStatus).values(
      rows.flatMap((episode) =>
        assertions.map((assertion) => ({
          animeId,
          episodeNumber: episode.number,
          languageCode: assertion.languageCode,
          mediaType: assertion.mediaType,
          status: "available" as const,
          provider: DERIVED_AIRDATE_PROVIDER,
          confidence: 75,
          checkedAt,
        })),
      ),
    );
  });

  await recalculateDerivedAirdateEvidence(animeId);
  return assertions.length ? rows.length : 0;
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

// ── Pass 1: Derived original audio ────────────────────────────────────────────

export async function runSubPass(): Promise<void> {
  log.divider();
  log.info(
    "Derived air-date pass — rebuilding conservative original-audio evidence…",
  );

  const today    = new Date().toISOString().split("T")[0]!;
  const BATCH    = 5_000;
  const CHUNK    = 1_000;
  let offset     = 0;
  let processed  = 0;

  const existingDerivedAnime = await db
    .selectDistinct({ animeId: episodeLanguageStatus.animeId })
    .from(episodeLanguageStatus)
    .where(eq(episodeLanguageStatus.provider, DERIVED_AIRDATE_PROVIDER));
  const affectedAnimeIds = new Set(existingDerivedAnime.map((row) => row.animeId));

  // This provider is entirely derived from current canonical metadata, so a full
  // maintenance pass can safely rebuild it from scratch. This also removes the
  // legacy English-subtitle rows that air dates never actually proved.
  await db
    .delete(episodeLanguageStatus)
    .where(eq(episodeLanguageStatus.provider, DERIVED_AIRDATE_PROVIDER));

  const airedJapaneseWhere = and(
    isNotNull(episodes.airDate),
    lte(episodes.airDate, today),
    eq(anime.countryOfOrigin, "JP"),
  );

  const [countRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(episodes)
    .innerJoin(anime, eq(episodes.animeId, anime.id))
    .where(airedJapaneseWhere);
  const total = countRow?.n ?? 0;

  log.info(`${total.toLocaleString()} aired Japanese-origin episodes to process`);

  const bar = log.progress(total, "Original audio");
  const checkedAt = new Date();

  while (true) {
    const rows = await db
      .select({ animeId: episodes.animeId, number: episodes.number })
      .from(episodes)
      .innerJoin(anime, eq(episodes.animeId, anime.id))
      .where(airedJapaneseWhere)
      .limit(BATCH)
      .offset(offset);

    if (!rows.length) break;

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await db.insert(episodeLanguageStatus).values(
        chunk.map((episode) => ({
          animeId: episode.animeId,
          episodeNumber: episode.number,
          languageCode: "ja",
          mediaType: "audio" as const,
          status: "available" as const,
          provider: DERIVED_AIRDATE_PROVIDER,
          confidence: 75,
          checkedAt,
        })),
      );

      for (const episode of chunk) affectedAnimeIds.add(episode.animeId);
      processed += chunk.length;
      bar.tick(chunk.length).setStats({ processed });
    }

    offset += BATCH;
    if (rows.length < BATCH) break;
  }

  bar.finish();

  for (const animeId of affectedAnimeIds) {
    await recalculateDerivedAirdateEvidence(animeId);
  }

  log.success(
    `Derived air-date pass complete — ${processed.toLocaleString()} episodes processed.`,
  );
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
  log.info(`  Ongoing dub      : ${ongoingDub.toLocaleString()} (no per-episode assertion)`);
  log.info(`  Unmatched        : ${unmatched.toLocaleString()}`);
  log.info(`  No episodes yet  : ${noEpisodes.toLocaleString()}`);
  log.info(`  Errors           : ${errors.toLocaleString()}`);
  log.divider();
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  installProxyFetch();
  try {
    if (RUN_SUB) await runSubPass();
    if (RUN_DUB) await runDubPass();
    log.success("Done.");
    await closeDb();
  } catch (err) {
    log.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
    await closeDb().catch(() => undefined);
    process.exit(1);
  }
}
