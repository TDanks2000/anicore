import { mkdirSync } from "node:fs";
import { and, eq } from "drizzle-orm";

import { closeDb, db } from "@anicore/db";
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
import { log, type ProgressBar } from "@anicore/providers/lib/logger";
import { withAnilistRetry } from "@anicore/providers/lib/anilist-rate-limit";
import { installProxyFetch } from "@anicore/providers/lib/proxy";
import {
	ensureSyncMonitorAccessCode,
	getSyncMonitorPublicConfig,
	type SyncMonitorStats,
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

const CHECKPOINT_EVERY = 10;
let activeMonitor: SyncMonitor | null = null;

function formatMonitorStats(stats: SyncStats): SyncMonitorStats {
	return {
		created: stats.created,
		updated: stats.updated,
		failed: stats.failed,
	};
}

function announceMonitor(): void {
	const code = ensureSyncMonitorAccessCode();
	const config = getSyncMonitorPublicConfig();
	log.info("Sync monitor enabled");
	log.info(`Access code saved locally: ${config.codePath}`);
	log.info(`Use Authorization: Bearer ${code}`);
	log.info(`Status file: ${config.statusPath}`);
	log.info(`Events file: ${config.eventsPath}`);
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

	process.exit(0);
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
	process.exit(0);
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
			log.error(`ID ${FROM_ID} not found in the ID list`);
			process.exit(1);
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
		monitor = new SyncMonitor({
			mode: "dry-run",
			total: count,
			startIndex,
			endIndex,
			parallel: 1,
			providers: ["anilist", ...PLUGINS.map((p) => p.name)],
		});
		activeMonitor = monitor;
	}

	const engine = new SyncEngine(PLUGINS);
	const results: DryRunEntry[] = [];
	let pluginErrors = 0;

	const stats = await engine.iterate(
		{ ids, startIndex, endIndex, label: "Dry-run" },
		async (id, index, bar): Promise<PerIdResult> => {
			const entry: DryRunEntry = {
				index,
				anilistId: id,
				anilist: { status: "error", message: "not processed" },
				plugins: {},
			};

			bar.setStage(`ID ${id} — anilist`);
			monitor?.stage("anilist", index, id);

			try {
				const anilistData = await withAnilistRetry(() => fetchAnilistAnime(id));
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
	monitor?.complete(formatMonitorStats(stats));
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
	if (VERIFY) await runVerify();
	if (DRY_RUN) {
		await runDryRun();
		process.exit(0);
	}

	for (const name of RESET_PROVIDERS) {
		const plugin = PLUGINS.find((p) => p.name === name);
		if (!plugin) {
			log.error(
				`Unknown provider '${name}'. Available: ${PLUGINS.map((p) => p.name).join(", ")}`,
			);
			process.exit(1);
		}
		await runProviderReset(name, plugin);
	}

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
			log.error(`ID ${FROM_ID} not found in the ID list`);
			process.exit(1);
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
	if (PARALLEL > 1) {
		log.info(
			`Parallel fetch enabled: ×${PARALLEL}; DB writes and downstream sync remain sequential`,
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
			parallel: PARALLEL,
			providers: ["anilist", ...PLUGINS.map((p) => p.name)],
		});
		activeMonitor = monitor;
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
			if (++processedSinceCheckpoint >= CHECKPOINT_EVERY) {
				await saveProgress(progress);
				processedSinceCheckpoint = 0;
			}
		},
	};

	const stats =
		PARALLEL > 1
			? await engine.iterateParallel(
					{ ...iterateOptions, concurrency: PARALLEL },
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
				)
			: await engine.iterate(
					iterateOptions,
					async (id, index, bar): Promise<PerIdResult> => {
						try {
							bar.setStage("anilist");
							monitor?.stage("anilist-fetch", index, id);
							const anilistData = await withAnilistRetry(() =>
								fetchAnilistAnime(id),
							);
							return await processFetchedAnime(
								id,
								index,
								anilistData,
								engine,
								bar,
								monitor,
							);
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							log.error(
								`ID ${id}: ${message}`,
							);
							monitor?.recordError(message, index, id);
							return { outcome: "failed" };
						}
					},
				);

	await saveProgress(progress);

	log.divider();
	log.success(`Sync complete — ${remaining.toLocaleString()} IDs processed`);
	log.info(`  Created  : ${stats.created.toLocaleString()}`);
	log.info(`  Updated  : ${stats.updated.toLocaleString()}`);
	log.info(`  Failed   : ${stats.failed.toLocaleString()}`);
	monitor?.complete(formatMonitorStats(stats));
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

try {
	await main();
	await closeDb();
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	log.error(`Fatal: ${message}`);
	failActiveMonitor(message);
	await closeDb().catch(() => undefined);
	process.exit(1);
}
