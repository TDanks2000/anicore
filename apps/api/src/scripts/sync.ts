import { mkdirSync } from "node:fs";
import { and, eq } from "drizzle-orm";

import { closeDb, db, tryAcquireSyncLease, type SyncLease } from "@anicore/db";
import { anime, animeMappings } from "@anicore/db/schema";
import {
	appendUnmatched,
	clearAllUnmatched,
	clearUnmatched,
	loadIds,
	loadProgress,
	loadUnmatched,
	resetProgress,
	saveProgress,
} from "@anicore/providers/lib/cache";
import { DEFAULT_AUTO_SYNC_INTERVAL_MINUTES } from "@anicore/sync-monitor";
import { log, type ProgressBar } from "@anicore/providers/lib/logger";
import { withAnilistRetry } from "@anicore/providers/lib/anilist-rate-limit";
import { installProxyFetch } from "@anicore/providers/lib/proxy";
import {
	createSyncMonitorBatch,
	ensureSyncMonitorAccessCode,
	ensureSyncMonitorRuntimeConfig,
	getSyncMonitorPublicConfig,
	readSyncMonitorControlState,
	readSyncMonitorRuntimeConfig,
	type SyncMonitorStats,
	type SyncMonitorRuntimeConfig,
	writeSyncMonitorControlState,
	SyncMonitor,
} from "../lib/sync-monitor";
import {
	type DryPluginEntry,
	type PerIdResult,
	type SyncStats,
	SyncEngine,
} from "@anicore/providers/lib/sync-engine";
import { fetchAnilistAnime } from "@anicore/providers/anilist/sync";
import { upsertAnimeFromProvider } from "@anicore/providers";
import {
	enrichEpisodeTitlesForAnime,
	previewEpisodeTitleEnrichment,
} from "@anicore/providers/episode-titles";
import { kitsuPlugin } from "@anicore/providers/kitsu/plugin";
import type { ProviderAnimeData, ProviderPlugin } from "@anicore/providers/types";
import {
	syncDubStatusForAnime,
	syncSubStatusForAnime,
} from "./sync-audio-status";

// ── CLI flags ─────────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);

installProxyFetch();

const flag = (name: string) => rawArgs.includes(name);
const flagValue = (prefix: string) =>
	rawArgs.find((a) => a.startsWith(prefix))?.slice(prefix.length);

const RESET_ALL = flag("--reset=all");
const RESET_PROVIDERS = rawArgs
	.filter((a) => /^--reset=\w+$/.test(a) && a !== "--reset=all")
	.map((a) => a.split("=")[1]!);
const REFRESH_IDS = flag("--refresh-ids");
const VERIFY = flag("--verify");
const DRY_RUN = flag("--dry-run");
const MONITOR_ENABLED = flag("--monitor") || process.env.ANICORE_SYNC_MONITOR === "1";
const FROM_ID = flagValue("--from=");
const FROM_INDEX = flagValue("--from-index=");
const LIMIT = flagValue("--limit=");
const DEFAULT_PARALLEL = 4;
const PARALLEL = parsePositiveIntegerFlag("--parallel=", DEFAULT_PARALLEL);

function parsePositiveIntegerFlag(prefix: string, fallback: number): number {
	const value = flagValue(prefix);
	if (value === undefined) return fallback;

	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		log.error(`${prefix.slice(0, -1)} must be a positive integer`);
		process.exit(1);
	}

	return parsed;
}

// ── Registered plugins ────────────────────────────────────────────────────────

const PLUGINS: ProviderPlugin[] = [kitsuPlugin];

let activeMonitor: SyncMonitor | null = null;
let activeRuntimeConfig: SyncMonitorRuntimeConfig | null = null;
let stopRequested = false;
let paused = false;

function formatMonitorStats(stats: SyncStats): SyncMonitorStats {
	return {
		created: stats.created,
		updated: stats.updated,
		failed: stats.failed,
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

function getDryRunEpisodeRows(
	plugins: Record<string, DryPluginEntry>,
): NonNullable<
	Parameters<typeof previewEpisodeTitleEnrichment>[2]
>["episodeRows"] {
	const episodeRows = Object.values(plugins)
		.flatMap((result) =>
			result.status === "matched" && "episodes" in result
				? (result.episodes ?? [])
				: [],
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
			changes.push(
				`checkpointEvery ${previous.checkpointEvery} -> ${next.checkpointEvery}`,
			);
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

async function waitForControlRelease(
	monitor?: SyncMonitor | null,
): Promise<boolean> {
	if (!monitor) return true;

	while (true) {
		const control = readSyncMonitorControlState();
		if (control.command === "stop") {
			if (!stopRequested) {
				stopRequested = true;
				monitor.stopping(control.message ?? "Stop requested from monitor");
			}
			return false;
		}

		if (control.command === "pause") {
			if (!paused) {
				paused = true;
				monitor.pause(control.message ?? "Pause requested from monitor");
			}
			await Bun.sleep(1000);
			refreshRuntimeConfig(monitor);
			continue;
		}

		if (control.command === "resume") {
			writeSyncMonitorControlState(null, null, "sync");
			if (paused) {
				paused = false;
				monitor.resume(control.message ?? "Resume requested from monitor");
			}
		}

		if (paused) {
			paused = false;
			monitor.resume("Sync resumed");
		}
		return true;
	}
}

// ── Verify mode ───────────────────────────────────────────────────────────────

async function runVerify(): Promise<void> {
	log.info("Querying DB for mapping coverage…");

	const rows = await db
		.select({ provider: animeMappings.provider })
		.from(animeMappings);

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

async function runProviderReset(
	providerName: string,
	plugin: ProviderPlugin,
): Promise<void> {
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
			appendUnmatched(providerName, parseInt(row.anilistId));
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
	episodeTitleEnrichment?: Awaited<
		ReturnType<typeof previewEpisodeTitleEnrichment>
	>;
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
		.where(
			and(
				eq(animeMappings.provider, provider),
				eq(animeMappings.providerId, providerId),
			),
		)
		.limit(1);

	return row?.animeId ?? null;
}

async function runDryRun(): Promise<void> {
	const ids = await loadIds(REFRESH_IDS);
	log.info(`Loaded ${ids.length.toLocaleString()} AniList IDs`);

	let startIndex = 0;
	if (FROM_ID) {
		const targetId = parseInt(FROM_ID);
		const idx = ids.indexOf(targetId);
		if (idx === -1) {
			throw new Error(`ID ${FROM_ID} not found in the ID list`);
		}
		startIndex = idx;
		log.info(`Starting from ID ${FROM_ID} (index ${idx})`);
	} else if (FROM_INDEX) {
		startIndex = parseInt(FROM_INDEX);
		log.info(`Starting from index ${startIndex}`);
	}

	const limit = LIMIT ? parseInt(LIMIT) : 5;
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
			getRateLimitMs: monitor
				? () => refreshRuntimeConfig(monitor).rateLimitMs
				: undefined,
			getConcurrency: monitor
				? () => refreshRuntimeConfig(monitor).parallel
				: undefined,
			onAfterEach: async ({ stats: s, index }) => {
				monitor?.update({ stats: formatMonitorStats(s), currentIndex: index });
				refreshRuntimeConfig(monitor);
			},
			beforeBatch: async () => waitForControlRelease(monitor),
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
					),
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				monitor?.recordError(message, index, id);
				reportIssue("error");
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
	log.success(
		`Dry-run complete — ${results.length} entries written to ${outPath}`,
	);

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
	const result = await upsertAnimeFromProvider(anilistData);

	monitor?.stage("provider-plugins", index, id);
	await engine.syncPlugins(id, anilistData, bar);

	bar.setStage("episode-titles");
	monitor?.stage("episode-titles", index, id);
	await enrichEpisodeTitlesForAnime(result.animeId, anilistData).catch((err) =>
		log.warn(
			`Episode title enrichment failed for ID ${id}: ${err instanceof Error ? err.message : String(err)}`,
		),
	);

	bar.setStage("audio");
	monitor?.stage("audio-sub", index, id);
	await syncSubStatusForAnime(result.animeId).catch((err) =>
		log.warn(
			`Audio status sync failed for ID ${id}: ${err instanceof Error ? err.message : String(err)}`,
		),
	);
	monitor?.stage("audio-dub", index, id);
	await syncDubStatusForAnime(result.animeId).catch((err) =>
		log.warn(
			`Audio status sync failed for ID ${id}: ${err instanceof Error ? err.message : String(err)}`,
		),
	);

	return { outcome: result.created ? "created" : "updated" };
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
		await resetProgress();
		clearAllUnmatched();
		log.info("Full reset — starting from scratch.");
	}

	const ids = await loadIds(REFRESH_IDS);
	log.info(`Loaded ${ids.length.toLocaleString()} AniList IDs`);

	let progress = await loadProgress();
	let startIndex = progress.lastIndex;

	if (FROM_ID) {
		const targetId = parseInt(FROM_ID);
		const idx = ids.indexOf(targetId);
		if (idx === -1) {
			throw new Error(`ID ${FROM_ID} not found in the ID list`);
		}
		startIndex = idx;
		progress = { ...progress, lastIndex: idx, stats: { created: 0, updated: 0, failed: 0 } };
		log.info(`Starting from ID ${FROM_ID} (index ${idx})`);
	} else if (FROM_INDEX) {
		startIndex = parseInt(FROM_INDEX);
		progress = { ...progress, lastIndex: startIndex, stats: { created: 0, updated: 0, failed: 0 } };
		log.info(`Starting from index ${startIndex}`);
	} else if (startIndex > 0) {
		log.info(
			`Resuming from index ${startIndex} (AniList ID ${ids[startIndex]})`,
		);
	}

	const maxCount = LIMIT ? parseInt(LIMIT) : Infinity;
	const endIndex = Math.min(
		ids.length,
		startIndex + (isFinite(maxCount) ? maxCount : ids.length),
	);
	const remaining = endIndex - startIndex;

	const pluginNames = PLUGINS.map((p) => p.name).join(" + ");
	log.divider();
	log.info(
		`Syncing ${remaining.toLocaleString()} IDs  ·  providers: anilist + ${pluginNames}`,
	);
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
		refreshRuntimeConfig(monitor);
	}

	const engine = new SyncEngine(PLUGINS);
	let processedSinceCheckpoint = 0;

	const iterateOptions = {
		ids,
		startIndex,
		endIndex,
		label: "Sync",
		onAfterEach: async ({ stats: s, index }: { stats: SyncStats; index: number }) => {
			progress.lastIndex = index + 1;
			progress.stats = s;
			monitor?.update({ stats: formatMonitorStats(s), currentIndex: index });
			const checkpointEvery =
				activeRuntimeConfig?.checkpointEvery ??
				initialRuntimeConfig.checkpointEvery;
			if (++processedSinceCheckpoint >= checkpointEvery) {
				await saveProgress(progress);
				processedSinceCheckpoint = 0;
			}
		},
	};

	const stats = await engine.iterateParallel(
		{
			...iterateOptions,
			concurrency: initialRuntimeConfig.parallel,
			getRateLimitMs: monitor
				? () => refreshRuntimeConfig(monitor).rateLimitMs
				: undefined,
			rateLimitMs: initialRuntimeConfig.rateLimitMs,
			getConcurrency: monitor
				? () => refreshRuntimeConfig(monitor).parallel
				: undefined,
			beforeBatch: async () => waitForControlRelease(monitor),
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
				return await withAnilistRetry(
					() => fetchAnilistAnime(id),
					() => reportIssue("rate-limit"),
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				monitor?.recordError(message, index, id);
				throw err;
			}
		},
		async (id, index, bar, anilistData) =>
			processFetchedAnime(id, index, anilistData, engine, bar, monitor),
	);

	await saveProgress(progress);

	log.divider();
	log.success(
		stopRequested
			? "Sync stopped by monitor request"
			: `Sync complete — ${remaining.toLocaleString()} IDs processed`,
	);
	log.info(`  Created  : ${stats.created.toLocaleString()}`);
	log.info(`  Updated  : ${stats.updated.toLocaleString()}`);
	log.info(`  Failed   : ${stats.failed.toLocaleString()}`);
	if (stopRequested) {
		monitor?.stop(formatMonitorStats(stats));
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
}

let syncLease: SyncLease | null = null;
let syncSucceeded = false;
try {
	syncLease = await tryAcquireSyncLease();
	if (!syncLease) {
		throw new Error("Another AniCore sync process already holds the database lease");
	}
	log.info(JSON.stringify({ event: "sync.lease.acquired" }));
	await main();
	syncSucceeded = true;
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	log.error(`Fatal: ${message}`);
	failActiveMonitor(message);
	process.exitCode = 1;
} finally {
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
