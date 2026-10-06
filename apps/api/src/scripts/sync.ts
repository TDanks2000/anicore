import { mkdirSync } from "node:fs";
import { closeDb, db, type SyncLease, tryAcquireSyncLease } from "@anicore/db";
import { anime, animeMappings, syncStageState } from "@anicore/db/schema";
import { upsertAnimeFromProvider } from "@anicore/providers";
import { fetchAnilistAnime } from "@anicore/providers/anilist/sync";
import {
  enrichEpisodeTitlesForAnime,
  previewEpisodeTitleEnrichment,
} from "@anicore/providers/episode-titles";
import { kitsuPlugin } from "@anicore/providers/kitsu/plugin";
import { isNotFoundError, withAnilistRetry } from "@anicore/providers/lib/anilist-rate-limit";
import {
  appendUnmatched,
  clearAllUnmatched,
  clearUnmatched,
  loadIds,
  loadProgress,
  resetProgress,
  saveProgress,
} from "@anicore/providers/lib/cache";
import { log, type ProgressBar } from "@anicore/providers/lib/logger";
import { setProviderWait } from "@anicore/providers/lib/provider-wait";
import { installProxyFetch } from "@anicore/providers/lib/proxy";
import { readStage, runSyncStage } from "@anicore/providers/lib/stage-state";
import {
  type DryPluginEntry,
  type PerIdResult,
  SyncEngine,
  type SyncStats,
} from "@anicore/providers/lib/sync-engine";
import { allSyncStagesFresh, animeRefreshTtl } from "@anicore/providers/lib/sync-freshness";
import type { ProviderAnimeData, ProviderPlugin } from "@anicore/providers/types";
import { DEFAULT_AUTO_SYNC_INTERVAL_MINUTES } from "@anicore/sync-monitor";
import { and, eq } from "drizzle-orm";
import { parseIntegerFlag, selectSyncIds } from "../lib/sync-cli";
import { SyncControl, SyncStoppedError } from "../lib/sync-control";
import {
  createSyncMonitorBatch,
  ensureSyncMonitorAccessCode,
  ensureSyncMonitorRuntimeConfig,
  getSyncMonitorPublicConfig,
  readSyncMonitorControlState,
  readSyncMonitorRuntimeConfig,
  readSyncMonitorStatus,
  SyncMonitor,
  type SyncMonitorRuntimeConfig,
  type SyncMonitorStats,
  writeSyncMonitorControlState,
} from "../lib/sync-monitor";
import { advanceSyncCheckpoint, createSyncCheckpointState } from "../lib/sync-progress";
import { LANGUAGE_SYNC_PROVIDERS, syncLanguageStatusForAnime } from "./sync-audio-status";

// ── CLI flags ─────────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);

installProxyFetch();

const flag = (name: string) => rawArgs.includes(name);

const RESET_ALL = flag("--reset=all");
const RESET_PROVIDERS = rawArgs
  .filter((a) => /^--reset=\w+$/.test(a) && a !== "--reset=all")
  .map((a) => a.split("=")[1]!);
const REFRESH_IDS = flag("--refresh-ids");
const VERIFY = flag("--verify");
const DRY_RUN = flag("--dry-run");
const MONITOR_ENABLED = flag("--monitor") || process.env.ANICORE_SYNC_MONITOR === "1";
const FROM_ID = readIntegerFlag("--from=", 1);
const FROM_INDEX = readIntegerFlag("--from-index=", 0);
const LIMIT = readIntegerFlag("--limit=", 1);
const DEFAULT_PARALLEL = 4;
const PARALLEL = readIntegerFlag("--parallel=", 1) ?? DEFAULT_PARALLEL;
const RECONCILE = flag("--reconcile");
const NEW_IDS_ONLY = flag("--new-ids-only");
const REVERSE = flag("--reverse");
const CUSTOM_SELECTION = NEW_IDS_ONLY || REVERSE;
const forceForId = new Map<number, boolean>();
const requestedSourceIds = new Set<number>();

function readIntegerFlag(prefix: string, minimum: number): number | undefined {
  try {
    return parseIntegerFlag(rawArgs, prefix, minimum);
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// ── Registered plugins ────────────────────────────────────────────────────────

const PLUGINS: ProviderPlugin[] = [kitsuPlugin];

let activeMonitor: SyncMonitor | null = null;
let activeRuntimeConfig: SyncMonitorRuntimeConfig | null = null;
let stopRequested = false;
let controls: SyncControl | null = null;

function startControls(): SyncControl | null {
  // API starts clear the previous command before spawning. A terminal start must
  // also discard controls from a finished run, while preserving startup requests.
  if (MONITOR_ENABLED) {
    const previous = readSyncMonitorStatus();
    const control = readSyncMonitorControlState();
    if (control.acknowledgedAt && previous && !SyncMonitor.isLikelyActive(previous)) {
      writeSyncMonitorControlState(null, null, "sync");
    }
  }
  const controller = MONITOR_ENABLED ? new SyncControl() : null;
  if (controller) {
    setProviderWait((milliseconds) => controller.sleep(milliseconds));
    const providerFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      if (!(await controller.waitForRelease())) throw new SyncStoppedError();
      const caller = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      return providerFetch(input, {
        ...init,
        signal: caller ? AbortSignal.any([caller, controller.signal]) : controller.signal,
      });
    }) as typeof fetch;
  }
  return controller;
}

async function controlSleep(milliseconds: number): Promise<void> {
  if (controls) await controls.sleep(milliseconds);
  else await Bun.sleep(milliseconds);
}

function formatMonitorStats(stats: SyncStats): SyncMonitorStats {
  return {
    created: stats.created,
    updated: stats.updated,
    failed: stats.failed,
    skipped: stats.skipped ?? 0,
  };
}

function announceMonitor(): void {
  ensureSyncMonitorAccessCode();
  ensureSyncMonitorRuntimeConfig({
    parallel: PARALLEL,
    checkpointEvery: 10,
  });
  const config = getSyncMonitorPublicConfig();
  log.info("Sync monitor enabled");
  log.info(`Access code saved locally: ${config.codePath}`);
  log.info(`Read the monitor access code from ${config.codePath}`);
  log.info(`Status file: ${config.statusPath}`);
  log.info(`Events file: ${config.eventsPath}`);
  log.info(`Runtime config file: ${config.runtimeConfigPath}`);
}

function failActiveMonitor(message: string): void {
  const monitor = activeMonitor;
  if (!monitor) return;
  monitor.fail(message);
  activeMonitor = null;
}

function stopActiveMonitor(): void {
  const monitor = activeMonitor;
  if (!monitor) return;
  monitor.stop(readSyncMonitorStatus()?.stats ?? { created: 0, updated: 0, failed: 0 });
  activeMonitor = null;
}

function getDryRunEpisodeRows(
  plugins: Record<string, DryPluginEntry>,
): NonNullable<Parameters<typeof previewEpisodeTitleEnrichment>[2]>["episodeRows"] {
  const episodeRows = Object.values(plugins)
    .flatMap((result) =>
      result.status === "matched" && "episodes" in result ? (result.episodes ?? []) : [],
    )
    .map((episode) => ({
      number: episode.number,
      title: episode.title ?? null,
      titleEnglish: episode.titleEnglish ?? null,
      titleRomaji: episode.titleRomaji ?? null,
      synopsis: episode.description ?? null,
      airDate: episode.airDate ?? null,
      seasonNumber: null,
    }));

  return episodeRows.length > 0 ? episodeRows : undefined;
}

function refreshRuntimeConfig(monitor?: SyncMonitor | null): SyncMonitorRuntimeConfig {
  const next = readSyncMonitorRuntimeConfig();
  const previous = activeRuntimeConfig;
  activeRuntimeConfig = next;

  if (monitor && previous && previous.updatedAt !== next.updatedAt) {
    const changes: string[] = [];
    if (previous.parallel !== next.parallel) {
      changes.push(`parallel ×${previous.parallel} -> ×${next.parallel}`);
    }
    if (previous.checkpointEvery !== next.checkpointEvery) {
      changes.push(`checkpointEvery ${previous.checkpointEvery} -> ${next.checkpointEvery}`);
    }
    if (previous.rateLimitMs !== next.rateLimitMs) {
      changes.push(`rateLimitMs ${previous.rateLimitMs} -> ${next.rateLimitMs}`);
    }
    if (changes.length > 0) {
      const message = `Runtime config updated: ${changes.join(", ")}`;
      log.info(message);
      monitor.event("info", message, { stage: "runtime-config" });
    }
  }

  monitor?.update({
    parallel: next.parallel,
    runtimeConfig: next,
  });
  return next;
}

async function waitForControlRelease(): Promise<boolean> {
  const released = (await controls?.waitForRelease()) ?? true;
  stopRequested = controls?.stopped ?? false;
  return released;
}

// ── Verify mode ───────────────────────────────────────────────────────────────

async function runVerify(): Promise<void> {
  log.info("Querying DB for mapping coverage…");

  const rows = await db.select({ provider: animeMappings.provider }).from(animeMappings);

  const counts: Record<string, number> = {};
  for (const { provider } of rows) {
    counts[provider] = (counts[provider] ?? 0) + 1;
  }

  const sorted = Object.entries(counts).sort(([, a], [, b]) => b - a);
  const maxCount = sorted[0]?.[1] ?? 0;

  log.divider();
  log.info("Mapping coverage:");
  for (const [provider, count] of sorted) {
    const bar = "█".repeat(Math.round((count / maxCount) * 20));
    const pad = provider.padEnd(14);
    const cnt = String(count).padStart(6);
    log.info(`  ${pad} ${cnt}  ${bar}`);
  }
  log.divider();
}

// ── Provider-reset mode ───────────────────────────────────────────────────────

async function runProviderReset(providerName: string, plugin: ProviderPlugin): Promise<void> {
  log.info(`Resetting '${providerName}' — finding anime missing this mapping…`);

  const alreadyMapped = await db
    .select({ animeId: animeMappings.animeId })
    .from(animeMappings)
    .where(eq(animeMappings.provider, providerName as never));

  const mappedSet = new Set(alreadyMapped.map((r) => r.animeId));

  const anilistRows = await db
    .select({
      animeId: animeMappings.animeId,
      anilistId: animeMappings.providerId,
      titleRomaji: anime.titleRomaji,
      titleEnglish: anime.titleEnglish,
      season: anime.season,
      seasonYear: anime.seasonYear,
      episodeCount: anime.episodeCount,
    })
    .from(animeMappings)
    .innerJoin(anime, eq(animeMappings.animeId, anime.id))
    .where(eq(animeMappings.provider, "anilist"));

  const toProcess = anilistRows.filter((r) => !mappedSet.has(r.animeId));

  clearUnmatched(providerName);
  log.info(`${toProcess.length} anime need '${providerName}' mapping`);

  let matched = 0;
  let unmatched = 0;
  let errors = 0;

  const bar = log.progress(toProcess.length, providerName);

  for (let i = 0; i < toProcess.length; i++) {
    const row = toProcess[i]!;

    const stubData: ProviderAnimeData = {
      provider: "anilist",
      providerId: row.anilistId,
      titleRomaji: row.titleRomaji,
      titleEnglish: row.titleEnglish,
      season: row.season,
      seasonYear: row.seasonYear,
      episodeCount: row.episodeCount,
    };

    const result = await plugin.sync(row.anilistId, stubData);

    if (result.status === "matched") {
      matched++;
    } else if (result.status === "unmatched") {
      unmatched++;
      appendUnmatched(providerName, Number(row.anilistId));
    } else {
      errors++;
      log.error(`AniList ${row.anilistId}: ${result.message}`);
    }

    bar.tick().setStats({ matched, unmatched, errors });

    if (i < toProcess.length - 1) await Bun.sleep(300);
  }

  bar.finish();
  log.divider();
  log.success(
    `'${providerName}' reset done — matched=${matched} unmatched=${unmatched} errors=${errors}`,
  );
}

// ── Dry-run mode ──────────────────────────────────────────────────────────────

interface DryRunEntry {
  index: number;
  anilistId: number;
  anilist:
    | {
        status: "ok";
        created: boolean;
        animeId: number | null;
        data: ProviderAnimeData;
      }
    | { status: "error"; message: string };
  plugins: Record<string, DryPluginEntry>;
  episodeTitleEnrichment?: Awaited<ReturnType<typeof previewEpisodeTitleEnrichment>>;
}

interface DryRunOutput {
  runAt: string;
  totalIdsAvailable: number;
  startIndex: number;
  processedCount: number;
  stats: {
    created: number;
    updated: number;
    failed: number;
    pluginErrors: number;
  };
  results: DryRunEntry[];
}

async function lookupAnimeMapping(
  provider: ProviderAnimeData["provider"],
  providerId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ animeId: animeMappings.animeId })
    .from(animeMappings)
    .where(and(eq(animeMappings.provider, provider), eq(animeMappings.providerId, providerId)))
    .limit(1);

  return row?.animeId ?? null;
}

async function loadSelectedIds(): Promise<number[]> {
  const ids = await loadIds(REFRESH_IDS);
  const existing = NEW_IDS_ONLY
    ? await db
        .select({ id: animeMappings.providerId })
        .from(animeMappings)
        .where(eq(animeMappings.provider, "anilist"))
    : [];
  const selected = selectSyncIds(
    ids,
    new Set(existing.map((row) => Number(row.id))),
    NEW_IDS_ONLY,
    REVERSE,
  );
  if (CUSTOM_SELECTION)
    log.info(
      `Selected ${selected.length.toLocaleString()} ${NEW_IDS_ONLY ? "new" : "all"} IDs, ${REVERSE ? "highest" : "lowest"} first; normal saved progress is unchanged`,
    );
  return selected;
}

async function runDryRun(): Promise<void> {
  const ids = await loadSelectedIds();
  log.info(`Loaded ${ids.length.toLocaleString()} AniList IDs`);

  let startIndex = 0;
  if (FROM_ID !== undefined) {
    const targetId = FROM_ID;
    const idx = ids.indexOf(targetId);
    if (idx === -1) {
      throw new Error(`ID ${FROM_ID} not found in the ID list`);
    }
    startIndex = idx;
    log.info(`Starting from ID ${FROM_ID} (index ${idx})`);
  } else if (FROM_INDEX !== undefined) {
    startIndex = Math.min(FROM_INDEX, ids.length);
    log.info(`Starting from index ${startIndex}`);
  }

  const limit = LIMIT ?? 5;
  const endIndex = Math.min(ids.length, startIndex + limit);
  const count = endIndex - startIndex;

  log.divider();
  log.info(
    `Dry-run: processing ${count} IDs through the sync loop without writing to the database`,
  );
  log.divider();

  let monitor: SyncMonitor | null = null;
  if (MONITOR_ENABLED) {
    announceMonitor();
    activeRuntimeConfig = readSyncMonitorRuntimeConfig();
    monitor = new SyncMonitor({
      mode: "dry-run",
      total: count,
      startIndex,
      endIndex,
      parallel: activeRuntimeConfig.parallel,
      providers: ["anilist", ...PLUGINS.map((p) => p.name)],
    });
    activeMonitor = monitor;
    controls?.attach(monitor);
    refreshRuntimeConfig(monitor);
  }

  const engine = new SyncEngine(PLUGINS);
  const results: DryRunEntry[] = [];
  let pluginErrors = 0;

  const stats = await engine.iterateParallel(
    {
      ids,
      startIndex,
      endIndex,
      label: "Dry-run",
      concurrency: activeRuntimeConfig?.parallel ?? PARALLEL,
      rateLimitMs: activeRuntimeConfig?.rateLimitMs,
      getRateLimitMs: monitor ? () => refreshRuntimeConfig(monitor).rateLimitMs : undefined,
      getConcurrency: monitor ? () => refreshRuntimeConfig(monitor).parallel : undefined,
      onAfterEach: async ({ stats: s, index }) => {
        monitor?.update({ stats: formatMonitorStats(s), currentIndex: index });
        refreshRuntimeConfig(monitor);
      },
      beforeBatch: async () => waitForControlRelease(),
      beforeEach: async () => waitForControlRelease(),
      sleep: async (milliseconds) => {
        try {
          await controlSleep(milliseconds);
        } catch (error) {
          if (!(error instanceof SyncStoppedError)) throw error;
        }
      },
      onBatchStart: ({
        startIndex: batchStart,
        endIndex: batchEnd,
        concurrency,
        ids: batchIds,
      }) => {
        monitor?.update({
          activeBatch: createSyncMonitorBatch({
            startIndex: batchStart,
            endIndex: batchEnd,
            concurrency,
            ids: batchIds,
          }),
        });
      },
      onBatchEnd: () => {
        monitor?.update({ activeBatch: null });
      },
      onConcurrencyChange: ({ previous, next }) => {
        if (previous === next) return;
        const message = `Parallel setting now ×${next}`;
        log.info(message);
        monitor?.event("info", message, { stage: "runtime-config" });
      },
    },
    async (id, index, reportIssue) => {
      monitor?.stage("anilist", index, id);
      try {
        return {
          status: "ok" as const,
          data: await withAnilistRetry(
            () => fetchAnilistAnime(id),
            () => reportIssue("rate-limit"),
            controlSleep,
          ),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        monitor?.recordError(message, index, id);
        if (!isNotFoundError(err)) reportIssue("error");
        return { status: "error" as const, message };
      }
    },
    async (id, index, bar, fetched): Promise<PerIdResult> => {
      const entry: DryRunEntry = {
        index,
        anilistId: id,
        anilist: { status: "error", message: "not processed" },
        plugins: {},
      };

      try {
        if (fetched.status === "error") {
          entry.anilist = { status: "error", message: fetched.message };
          log.error(`ID ${id}: ${fetched.message}`);
          results.push(entry);
          return { outcome: "failed", extra: { pluginErrors } };
        }

        const anilistData = fetched.data;
        const existingAnimeId = await lookupAnimeMapping(
          anilistData.provider,
          anilistData.providerId,
        );

        entry.anilist = {
          status: "ok",
          created: existingAnimeId === null,
          animeId: existingAnimeId,
          data: anilistData,
        };

        monitor?.stage("plugins", index, id);
        entry.plugins = await engine.dryPlugins(id, anilistData, bar);

        for (const result of Object.values(entry.plugins)) {
          if (result.status === "error") pluginErrors++;
        }

        monitor?.stage("episode-title-preview", index, id);
        entry.episodeTitleEnrichment = await previewEpisodeTitleEnrichment(
          existingAnimeId,
          anilistData,
          { episodeRows: getDryRunEpisodeRows(entry.plugins) },
        );

        results.push(entry);
        return {
          outcome: existingAnimeId === null ? "created" : "updated",
          extra: { pluginErrors },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        entry.anilist = { status: "error", message };
        log.error(`ID ${id}: ${message}`);
        monitor?.recordError(message, index, id);
        results.push(entry);
        return { outcome: "failed", extra: { pluginErrors } };
      }
    },
  );
  stopRequested = controls?.stopped ?? stopRequested;
  if (stopRequested) {
    monitor?.stop(formatMonitorStats(stats));
  } else {
    monitor?.complete(formatMonitorStats(stats));
  }
  activeMonitor = null;

  const output: DryRunOutput = {
    runAt: new Date().toISOString(),
    totalIdsAvailable: ids.length,
    startIndex,
    processedCount: results.length,
    stats: { ...stats, pluginErrors },
    results,
  };

  mkdirSync("data", { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = `data/dry-run-${ts}.json`;
  await Bun.write(outPath, JSON.stringify(output, null, 2));

  log.divider();
  log.success(`Dry-run complete — ${results.length} entries written to ${outPath}`);

  for (const { anilistId, anilist, plugins, episodeTitleEnrichment } of results) {
    if (anilist.status === "error") {
      log.error(`  [${anilistId}] ${anilist.message}`);
      continue;
    }

    const title = anilist.data.titleEnglish ?? anilist.data.titleRomaji;
    const pluginSummary = Object.entries(plugins)
      .map(([name, r]) => {
        if (r.status === "error") return `${name}:ERR`;
        if (r.status === "skipped") return `${name}:SKIP`;
        if (r.status === "matched") return `${name}:✔ ${r.providerId}`;
        return `${name}:✖`;
      })
      .join("  ");
    const disposition = anilist.created ? "create" : "update";
    const enrichment = episodeTitleEnrichment;
    const enrichmentSummary =
      enrichment && enrichment.matches.length > 0
        ? `  titles:${enrichment.sourcesUsed.join("->")} (+${enrichment.possibleUpdates})`
        : "";
    const enrichmentErrors =
      enrichment && enrichment.errors.length > 0
        ? `  title-errors:${enrichment.errors.join(", ")}`
        : "";
    log.info(
      `  [${anilistId}] ${title}  ${disposition}  ${pluginSummary}${enrichmentSummary}${enrichmentErrors}`,
    );
  }

  log.divider();
}

// ── Main sync ─────────────────────────────────────────────────────────────────

async function processFetchedAnime(
  id: number,
  index: number,
  anilistData: ProviderAnimeData,
  engine: SyncEngine,
  bar: ProgressBar,
  monitor?: SyncMonitor | null,
): Promise<PerIdResult> {
  monitor?.stage("database-upsert", index, id);
  const force = forceForId.get(id) ?? true;
  const ttl = animeRefreshTtl(anilistData);
  const result = await runSyncStage(
    id,
    "anime-upsert",
    ttl,
    () => upsertAnimeFromProvider(anilistData),
    force,
  );

  monitor?.stage("provider-plugins", index, id);
  await engine.syncPlugins(id, anilistData, bar);

  bar.setStage("episode-titles");
  monitor?.stage("episode-titles", index, id);
  await runSyncStage(
    id,
    "episode-titles",
    ttl,
    () => enrichEpisodeTitlesForAnime(result.animeId, anilistData),
    force,
  ).catch((err) =>
    log.warn(
      `Episode title enrichment failed for ID ${id}: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );

  bar.setStage("audio");
  monitor?.stage("audio-sub", index, id);
  monitor?.stage("audio-dub", index, id);
  const languageSync = await syncLanguageStatusForAnime(result.animeId, (name, operation) =>
    runSyncStage(id, `language:${name}`, animeRefreshTtl(anilistData, true), operation, force),
  );
  for (const error of languageSync.errors)
    log.warn(`Language status sync failed for ID ${id}: ${error}`);
  for (const warning of languageSync.warnings)
    log.warn(`Optional language provider for ID ${id}: ${warning}`);
  if (languageSync.errors.length)
    throw new Error(`Language sync failed: ${languageSync.errors.join("; ")}`);

  return { outcome: result.created && force ? "created" : "updated" };
}

async function main(): Promise<void> {
  if (VERIFY) {
    await runVerify();
    return;
  }
  if (DRY_RUN) {
    await runDryRun();
    return;
  }

  for (const name of RESET_PROVIDERS) {
    const plugin = PLUGINS.find((p) => p.name === name);
    if (!plugin) {
      throw new Error(
        `Unknown provider '${name}'. Available: ${PLUGINS.map((p) => p.name).join(", ")}`,
      );
    }
    await runProviderReset(name, plugin);
  }
  if (RESET_PROVIDERS.length > 0) return;

  if (RESET_ALL) {
    if (!CUSTOM_SELECTION) await resetProgress();
    clearAllUnmatched();
    log.info("Full reset — starting from scratch.");
  }

  const ids = await loadSelectedIds();
  log.info(`Loaded ${ids.length.toLocaleString()} AniList IDs`);

  let progress = CUSTOM_SELECTION
    ? { version: 1, lastIndex: 0, stats: { created: 0, updated: 0, failed: 0 } }
    : await loadProgress();
  let startIndex = Math.min(progress.lastIndex, ids.length);

  if (FROM_ID !== undefined) {
    const targetId = FROM_ID;
    const idx = ids.indexOf(targetId);
    if (idx === -1) {
      throw new Error(`ID ${FROM_ID} not found in the ID list`);
    }
    startIndex = idx;
    progress = { ...progress, lastIndex: idx, stats: { created: 0, updated: 0, failed: 0 } };
    log.info(`Starting from ID ${FROM_ID} (index ${idx})`);
  } else if (FROM_INDEX !== undefined) {
    startIndex = Math.min(FROM_INDEX, ids.length);
    progress = { ...progress, lastIndex: startIndex, stats: { created: 0, updated: 0, failed: 0 } };
    log.info(`Starting from index ${startIndex}`);
  } else if (startIndex > 0) {
    log.info(`Resuming from index ${startIndex} (AniList ID ${ids[startIndex]})`);
  }

  const maxCount = LIMIT ?? Infinity;
  const endIndex = Math.min(
    ids.length,
    startIndex + (Number.isFinite(maxCount) ? maxCount : ids.length),
  );
  const remaining = endIndex - startIndex;

  const pluginNames = PLUGINS.map((p) => p.name).join(" + ");
  log.divider();
  log.info(`Syncing ${remaining.toLocaleString()} IDs  ·  providers: anilist + ${pluginNames}`);
  const initialRuntimeConfig = MONITOR_ENABLED
    ? ensureSyncMonitorRuntimeConfig({
        parallel: PARALLEL,
        checkpointEvery: 10,
      })
    : {
        version: 1 as const,
        parallel: PARALLEL,
        checkpointEvery: 10,
        rateLimitMs: 1500,
        startMode: "sync" as const,
        startLimit: null,
        startFromIndex: null,
        refreshIds: false,
        resetAll: false,
        newIdsOnly: false,
        idOrder: "ascending" as const,
        autoSyncEnabled: true,
        autoSyncIntervalMinutes: DEFAULT_AUTO_SYNC_INTERVAL_MINUTES,
        updatedAt: new Date().toISOString(),
        updatedBy: "sync" as const,
      };
  activeRuntimeConfig = initialRuntimeConfig;

  if (initialRuntimeConfig.parallel > 1) {
    log.info(
      `Parallel fetch enabled: ×${initialRuntimeConfig.parallel}; DB writes and downstream sync remain sequential`,
    );
  }
  log.divider();

  let monitor: SyncMonitor | null = null;
  if (MONITOR_ENABLED) {
    announceMonitor();
    monitor = new SyncMonitor({
      mode: "sync",
      total: remaining,
      startIndex,
      endIndex,
      parallel: initialRuntimeConfig.parallel,
      providers: ["anilist", ...PLUGINS.map((p) => p.name)],
    });
    activeMonitor = monitor;
    controls?.attach(monitor);
    refreshRuntimeConfig(monitor);
  }

  const fullReconciliation = RECONCILE;
  const engine = new SyncEngine(PLUGINS, (id, name, data, operation) =>
    runSyncStage(
      id,
      `provider:${name}`,
      animeRefreshTtl(data),
      operation,
      forceForId.get(id) ?? true,
    ),
  );
  let processedSinceCheckpoint = 0;
  let checkpointState = createSyncCheckpointState();

  const iterateOptions = {
    ids,
    startIndex,
    endIndex,
    label: "Sync",
    onAfterEach: async ({ stats: s, index }: { stats: SyncStats; index: number }) => {
      forceForId.delete(ids[index]!);
      requestedSourceIds.delete(ids[index]!);
      checkpointState = advanceSyncCheckpoint(progress, s, index, checkpointState);
      monitor?.update({ stats: formatMonitorStats(s), currentIndex: index });
      const checkpointEvery =
        activeRuntimeConfig?.checkpointEvery ?? initialRuntimeConfig.checkpointEvery;
      if (++processedSinceCheckpoint >= checkpointEvery) {
        if (!CUSTOM_SELECTION) await saveProgress(progress);
        processedSinceCheckpoint = 0;
      }
    },
  };

  const stats = await engine.iterateParallel(
    {
      ...iterateOptions,
      getFetchBudgetCost: (id: number) => (requestedSourceIds.has(id) ? 1 : 0),
      concurrency: initialRuntimeConfig.parallel,
      getRateLimitMs: monitor ? () => refreshRuntimeConfig(monitor).rateLimitMs : undefined,
      rateLimitMs: initialRuntimeConfig.rateLimitMs,
      getConcurrency: monitor ? () => refreshRuntimeConfig(monitor).parallel : undefined,
      beforeBatch: async () => waitForControlRelease(),
      beforeEach: async () => waitForControlRelease(),
      sleep: async (milliseconds) => {
        try {
          await controlSleep(milliseconds);
        } catch (error) {
          if (!(error instanceof SyncStoppedError)) throw error;
        }
      },
      onBatchStart: ({
        startIndex: batchStart,
        endIndex: batchEnd,
        concurrency,
        ids: batchIds,
      }) => {
        monitor?.update({
          activeBatch: createSyncMonitorBatch({
            startIndex: batchStart,
            endIndex: batchEnd,
            concurrency,
            ids: batchIds,
          }),
        });
      },
      onBatchEnd: () => {
        monitor?.update({ activeBatch: null });
      },
      onConcurrencyChange: ({ previous, next }) => {
        if (previous === next) return;
        const message = `Parallel setting now ×${next}`;
        log.info(message);
        monitor?.event("info", message, { stage: "runtime-config" });
      },
    },
    async (id, index, reportIssue) => {
      monitor?.stage("anilist-fetch", index, id);
      try {
        const missing = (await lookupAnimeMapping("anilist", String(id))) === null;
        // An on-demand import may have added this ID after selection.
        if (NEW_IDS_ONLY && !missing) return "fresh" as const;
        const prior = await readStage(id, "anilist-fetch");
        const recentlyMissing =
          prior?.payloadJson === "null" &&
          prior.failures === 0 &&
          (prior.nextDueAt ?? 0) > Date.now();
        const force = RECONCILE || (missing && !recentlyMissing);
        forceForId.set(id, force);
        if (!missing && !force) {
          const states = await db
            .select()
            .from(syncStageState)
            .where(eq(syncStageState.anilistId, id));
          const required = [
            "anilist-fetch",
            "anime-upsert",
            "episode-titles",
            ...engine.activePluginsFor(id).map((plugin) => `provider:${plugin.name}`),
            ...Object.keys(LANGUAGE_SYNC_PROVIDERS).map((name) => `language:${name}`),
          ];
          if (allSyncStagesFresh(states, required)) return "fresh" as const;
        }
        return await runSyncStage(
          id,
          "anilist-fetch",
          (data: ProviderAnimeData | null) => (data ? animeRefreshTtl(data) : 30 * 24 * 3600_000),
          () => {
            requestedSourceIds.add(id);
            return withAnilistRetry(
              () => fetchAnilistAnime(id),
              () => reportIssue("rate-limit"),
              controlSleep,
            ).catch((error) => {
              if (isNotFoundError(error)) return null;
              throw error;
            });
          },
          force,
        );
      } catch (err) {
        // AniList's ID list has entries that were since deleted. Retrying them
        // can never succeed, so they must not hold back the resume checkpoint.
        if (isNotFoundError(err)) return null;
        const message = err instanceof Error ? err.message : String(err);
        monitor?.recordError(message, index, id);
        throw err;
      }
    },
    async (id, index, bar, anilistData): Promise<PerIdResult> => {
      if (anilistData === "fresh") {
        monitor?.stage("fresh-skipped", index, id);
        return { outcome: "skipped" };
      }
      if (anilistData === null) {
        const message = `ID ${id}: no longer on AniList — skipped`;
        log.info(message);
        monitor?.event("info", message, { stage: "anilist-fetch" });
        return { outcome: "skipped" };
      }
      return processFetchedAnime(id, index, anilistData, engine, bar, monitor);
    },
  );

  stopRequested = controls?.stopped ?? stopRequested;
  if (!CUSTOM_SELECTION) await saveProgress(progress);
  if (
    fullReconciliation &&
    !CUSTOM_SELECTION &&
    stats.failed === 0 &&
    !stopRequested &&
    startIndex === 0 &&
    endIndex === ids.length
  ) {
    await runSyncStage(0, "reconciliation", 30 * 24 * 3600_000, async () => true, true);
  }

  const incompleteMessage =
    stats.failed > 0
      ? `Sync incomplete — ${stats.failed.toLocaleString()} ID${stats.failed === 1 ? "" : "s"} failed; ${CUSTOM_SELECTION ? "run an all-ID sync to repair incomplete entries" : `retry will resume from index ${progress.lastIndex}`}`
      : null;

  log.divider();
  stopRequested = controls?.stopped ?? stopRequested;
  if (stopRequested) {
    log.warn("Sync stopped by monitor request");
  } else if (incompleteMessage) {
    log.error(incompleteMessage);
  } else {
    log.success(`Sync complete — ${remaining.toLocaleString()} IDs processed`);
  }
  log.info(`  Created  : ${stats.created.toLocaleString()}`);
  log.info(`  Updated  : ${stats.updated.toLocaleString()}`);
  log.info(`  Failed   : ${stats.failed.toLocaleString()}`);
  if (stats.skipped)
    log.info(`  Skipped  : ${stats.skipped.toLocaleString()} (fresh or no longer on AniList)`);

  stopRequested = controls?.stopped ?? stopRequested;
  if (stopRequested) {
    monitor?.stop(formatMonitorStats(stats));
  } else if (incompleteMessage) {
    monitor?.fail(incompleteMessage);
  } else {
    monitor?.complete(formatMonitorStats(stats));
  }
  activeMonitor = null;

  for (const [provider, unmatched] of engine.unmatchedSets) {
    if (unmatched.size > 0) {
      log.warn(
        `  ${provider} unmatched: ${unmatched.size} (see data/cache/${provider}_unmatched.txt)`,
      );
    }
  }

  log.divider();

  if (incompleteMessage) {
    throw new Error(incompleteMessage);
  }
}

let syncLease: SyncLease | null = null;
let syncSucceeded = false;
try {
  syncLease = await tryAcquireSyncLease();
  if (!syncLease) {
    throw new Error("Another AniCore sync process already holds the database lease");
  }
  controls = startControls();
  log.info(JSON.stringify({ event: "sync.lease.acquired" }));
  await main();
  syncSucceeded = !controls?.stopped;
} catch (err) {
  if (controls?.stopped) {
    stopRequested = true;
    stopActiveMonitor();
  } else {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Fatal: ${message}`);
    failActiveMonitor(message);
    process.exitCode = 1;
  }
} finally {
  controls?.dispose();
  if (syncLease) {
    try {
      await syncLease.release(syncSucceeded);
      log.info(JSON.stringify({ event: "sync.lease.released" }));
    } catch (error) {
      log.error(
        JSON.stringify({
          event: "sync.lease.failed",
          err: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  await closeDb().catch(() => undefined);
}
