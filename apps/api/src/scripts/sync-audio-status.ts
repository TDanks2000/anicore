import { closeDb, db, type SyncLease, tryAcquireSyncLease } from "@anicore/db";
import { syncAnimeLanguageEvidenceFromEpisodeStatuses } from "@anicore/db/language-status";
import { anime, animeMappings, episodeLanguageStatus, episodes } from "@anicore/db/schema";
import { syncAnilistCastLanguages } from "@anicore/providers/anilist/languages";
import { type DubSyncResult, syncDubStatus } from "@anicore/providers/animeschedule/sync";
import { syncCrunchyrollLanguages } from "@anicore/providers/crunchyroll/sync";
import { JikanCircuitOpenError, syncVoiceCastLanguages } from "@anicore/providers/jikan/sync";
import { syncKitsuLanguages } from "@anicore/providers/kitsu/languages";
import { log } from "@anicore/providers/lib/logger";
import { installProxyFetch } from "@anicore/providers/lib/proxy";
import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { derivedAirdateLanguageAssertions } from "../lib/derived-airdate-language";
import { parseIntegerFlag } from "../lib/sync-cli";

const args = process.argv.slice(2);
const SUB_ONLY = args.includes("--sub-only");
const DUB_ONLY = args.includes("--dub-only");

const RUN_SUB = !DUB_ONLY;
const RUN_DUB = !SUB_ONLY;
const DERIVED_AIRDATE_PROVIDER = "derived-airdate";

function readFromIndex(): number {
  return parseIntegerFlag(args, "--from=", 0) ?? 0;
}

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
      and(eq(episodes.animeId, animeId), isNotNull(episodes.airDate), lte(episodes.airDate, today)),
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

export async function syncDubStatusForAnime(animeId: number): Promise<DubSyncResult> {
  const rows = await db
    .select({
      animeId: animeMappings.animeId,
      anilistId: animeMappings.providerId,
      slug: anime.slug,
      titleRomaji: anime.titleRomaji,
      titleEnglish: anime.titleEnglish,
    })
    .from(animeMappings)
    .innerJoin(anime, eq(animeMappings.animeId, anime.id))
    .where(and(eq(animeMappings.provider, "anilist"), eq(animeMappings.animeId, animeId)));

  if (rows.length !== 1) {
    throw new Error(`Expected one AniList mapping for anime ${animeId}; found ${rows.length}`);
  }
  const row = rows[0]!;

  return syncDubStatus({
    animeId: row.animeId,
    anilistId: row.anilistId,
    slug: row.slug,
    titleRomaji: row.titleRomaji,
    titleEnglish: row.titleEnglish ?? null,
  });
}

/** Providers fail independently so a schedule outage cannot suppress cast evidence. */
export async function syncLanguageStatusForAnime(
  animeId: number,
): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [name, sync] of [
    ["original-audio", syncSubStatusForAnime],
    ["animeschedule", syncDubStatusForAnime],
    ["crunchyroll", syncCrunchyrollLanguages],
    ["anilist-cast", syncAnilistCastLanguages],
    ["jikan", syncVoiceCastLanguages],
    ["kitsu-languages", syncKitsuLanguages],
  ] as const) {
    try {
      await sync(animeId);
    } catch (error) {
      // The cooldown was already announced once; repeating it per anime is noise.
      if (error instanceof JikanCircuitOpenError) continue;
      const message = `${name}: ${error instanceof Error ? error.message : String(error)}`;
      if (name === "jikan" && isOptionalJikanFailure(message)) warnings.push(message);
      else errors.push(message);
    }
  }
  return { errors, warnings };
}

function isOptionalJikanFailure(message: string): boolean {
  return /\b(429|5\d\d)\b|timed out|timeout|connection|temporarily unavailable|failed to fetch/i.test(
    message,
  );
}

// ── Pass 1: Derived original audio ────────────────────────────────────────────

export async function runSubPass(): Promise<void> {
  log.divider();
  log.info("Derived air-date pass — rebuilding conservative original-audio evidence…");

  const today = new Date().toISOString().split("T")[0]!;
  const BATCH = 5_000;
  const CHUNK = 1_000;
  let offset = 0;
  let processed = 0;

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
    sql`upper(trim(${anime.countryOfOrigin})) = 'JP'`,
  );

  const [countRow] = await db
    .select({ n: sql<number>`count(*)` })
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

  log.success(`Derived air-date pass complete — ${processed.toLocaleString()} episodes processed.`);
}

// ── Pass 2: Dub ───────────────────────────────────────────────────────────────

export async function runDubPass(
  fromIndex = readFromIndex(),
): Promise<{ errors: number; processed: number }> {
  log.divider();
  log.info(
    "Language pass — AnimeSchedule, Crunchyroll episode tracks, AniList/MAL voice cast and Kitsu streaming links…",
  );

  const rows = await db
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
        parseIntegerFlag(args, "--anime-id=", 1)
          ? eq(anime.id, parseIntegerFlag(args, "--anime-id=", 1)!)
          : undefined,
      ),
    )
    .orderBy(asc(anime.id), asc(animeMappings.providerId));

  const total = rows.length;
  const limit = parseIntegerFlag(args, "--limit=", 1);
  const endIndex = limit ? Math.min(total, fromIndex + limit) : total;
  log.info(`${total.toLocaleString()} anime to process (starting at index ${fromIndex})`);

  let fullyDubbed = 0;
  let unknown = 0;
  let knownDub = 0;
  let castMatched = 0;
  let ongoingDub = 0;
  let unmatched = 0;
  let errors = 0;
  let warnings = 0;
  let anilistCastMatched = 0;
  let crunchyrollEpisodes = 0;
  let crunchyrollSeriesOnly = 0;

  const bar = log.progress(Math.max(0, endIndex - fromIndex), "Languages");

  for (let i = fromIndex; i < endIndex; i++) {
    const row = rows[i]!;

    bar.setStage(row.titleEnglish ?? row.titleRomaji ?? String(row.anilistId));

    try {
      const result = await syncDubStatusForAnime(row.animeId);

      switch (result.status) {
        case "matched-fully-dubbed":
          fullyDubbed++;
          break;
        case "matched-unknown":
          unknown++;
          break;
        case "matched-dub":
          knownDub++;
          break;
        case "matched-ongoing-dub":
          ongoingDub++;
          break;
        case "unmatched":
          unmatched++;
          break;
      }
    } catch (err) {
      errors++;
      log.error(
        `animeId=${row.animeId} anilist=${row.anilistId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const result = await syncCrunchyrollLanguages(row.animeId);
      if (result.status === "matched") crunchyrollEpisodes++;
      if (result.status === "series-only") crunchyrollSeriesOnly++;
    } catch (err) {
      errors++;
      log.error(
        `Crunchyroll animeId=${row.animeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      const result = await syncAnilistCastLanguages(row.animeId);
      if (result.status === "matched") anilistCastMatched++;
    } catch (err) {
      errors++;
      log.error(
        `AniList cast animeId=${row.animeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      const cast = await syncVoiceCastLanguages(row.animeId);
      if (cast.status === "matched") castMatched++;
    } catch (err) {
      const message = `Jikan animeId=${row.animeId}: ${err instanceof Error ? err.message : String(err)}`;
      if (isOptionalJikanFailure(message)) {
        warnings++;
        log.warn(message);
      } else {
        errors++;
        log.error(message);
      }
    }
    try {
      await syncKitsuLanguages(row.animeId);
    } catch (err) {
      errors++;
      log.error(
        `Kitsu languages animeId=${row.animeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    bar.tick().setStats({
      dubbed: fullyDubbed + knownDub,
      unknown,
      ongoing: ongoingDub,
      cast: castMatched,
      crunchyroll: crunchyrollEpisodes,
      errors,
      warnings,
    });
  }

  bar.finish();
  log.divider();
  log.success("Dub pass complete.");
  log.info(`  Fully dubbed     : ${fullyDubbed.toLocaleString()}`);
  log.info(`  Dub exists       : ${knownDub.toLocaleString()} (episode coverage unknown)`);
  log.info(`  Unknown dub      : ${unknown.toLocaleString()}`);
  log.info(`  Partial coverage : ${ongoingDub.toLocaleString()}`);
  log.info(`  Voice cast       : ${castMatched.toLocaleString()}`);
  log.info(`  AniList cast     : ${anilistCastMatched.toLocaleString()}`);
  log.info(
    `  Crunchyroll      : ${crunchyrollEpisodes.toLocaleString()} per episode, ${crunchyrollSeriesOnly.toLocaleString()} series only`,
  );
  log.info(`  Provider warnings: ${warnings.toLocaleString()}`);
  log.info(`  Unmatched        : ${unmatched.toLocaleString()}`);
  log.info(`  Errors           : ${errors.toLocaleString()}`);
  log.divider();
  return { errors, processed: Math.max(0, endIndex - fromIndex) };
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  installProxyFetch();
  let syncLease: SyncLease | null = null;
  let syncSucceeded = false;
  try {
    syncLease = await tryAcquireSyncLease();
    if (!syncLease) {
      throw new Error("Another AniCore sync process already holds the database lease");
    }
    log.info(JSON.stringify({ event: "sync.audio.lease.acquired" }));

    if (SUB_ONLY && DUB_ONLY) throw new Error("--sub-only and --dub-only cannot be combined");
    const animeId = parseIntegerFlag(args, "--anime-id=", 1);
    if (RUN_SUB) {
      if (animeId) await syncSubStatusForAnime(animeId);
      else await runSubPass();
    }
    const languagePass = RUN_DUB ? await runDubPass() : { errors: 0 };
    syncSucceeded = languagePass.errors === 0;
    if (!syncSucceeded) process.exitCode = 1;
    else log.success("Done.");
  } catch (err) {
    log.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    if (syncLease) {
      try {
        await syncLease.release(syncSucceeded);
        log.info(JSON.stringify({ event: "sync.audio.lease.released" }));
      } catch (error) {
        log.error(
          `Failed to release audio sync lease: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      }
    }
    await closeDb().catch(() => undefined);
  }
}
