import { appendUnmatched, loadUnmatched } from "./cache";
import { ANILIST_RATE_MS, isRateLimitError } from "./anilist-rate-limit";
import { log, ProgressBar } from "./logger";
import type {
	DryPluginResult,
	ProviderAnimeData,
	ProviderPlugin,
} from "../providers/types";

export type SyncOutcome = "created" | "updated" | "failed";

export interface SyncStats {
	created: number;
	updated: number;
	failed: number;
}

export interface PerIdResult {
	outcome: SyncOutcome;
	/** Extra stats merged into the progress bar display. */
	extra?: Record<string, number>;
}

export interface IterateOptions {
	ids: number[];
	startIndex: number;
	endIndex: number;
	label: string;
	/** Called after each item — use for progress checkpointing. */
	onAfterEach?: (ctx: { stats: SyncStats; index: number }) => Promise<void>;
}

export type DryPluginEntry =
	| DryPluginResult
	| { status: "skipped"; message: string };

// ── Adaptive parallel controller ──────────────────────────────────────────────

class AdaptiveController {
	private _concurrency: number;
	private window: ("ok" | "rate-limit" | "error")[] = [];
	private backoffBatchesLeft = 0;

	constructor(
		private readonly maxConcurrency: number,
		private readonly windowSize = 20,
		private readonly failureThreshold = 0.25,
		private readonly backoffBatches = 10,
	) {
		this._concurrency = maxConcurrency;
	}

	get currentConcurrency(): number {
		return this._concurrency;
	}

	get statusLabel(): string {
		if (this.backoffBatchesLeft > 0) {
			return `sequential (${this.backoffBatchesLeft} batches left, then ×${this.maxConcurrency})`;
		}
		return `×${this._concurrency} parallel`;
	}

	/** Record one fetch outcome. Returns true if this triggered a new backoff. */
	record(kind: "ok" | "rate-limit" | "error"): boolean {
		this.window.push(kind);
		if (this.window.length > this.windowSize) this.window.shift();

		if (
			kind !== "ok" &&
			this._concurrency > 1 &&
			this.backoffBatchesLeft === 0
		) {
			const failureRate =
				this.window.filter((r) => r !== "ok").length / this.window.length;
			if (failureRate >= this.failureThreshold) {
				this._concurrency = 1;
				this.backoffBatchesLeft = this.backoffBatches;
				return true;
			}
		}
		return false;
	}

	batchDone(): void {
		if (this.backoffBatchesLeft > 0) {
			this.backoffBatchesLeft--;
			if (this.backoffBatchesLeft === 0) {
				this._concurrency = this.maxConcurrency;
				log.info(
					`Parallel backoff lifted — restoring ×${this.maxConcurrency}`,
				);
			}
		}
	}
}

// ── SyncEngine ────────────────────────────────────────────────────────────────

export class SyncEngine {
	/** Per-plugin sets of AniList IDs that previously had no match. */
	readonly unmatchedSets: Map<string, Set<number>>;

	constructor(readonly plugins: ProviderPlugin[]) {
		this.unmatchedSets = new Map(
			plugins.map((p) => [p.name, loadUnmatched(p.name)]),
		);
	}

	activePluginsFor(id: number): ProviderPlugin[] {
		return this.plugins.filter(
			(p) => !this.unmatchedSets.get(p.name)?.has(id),
		);
	}

	markUnmatched(pluginName: string, id: number): void {
		this.unmatchedSets.get(pluginName)?.add(id);
		appendUnmatched(pluginName, id);
	}

	/** Run all active plugins for an ID in real mode (writes to DB). */
	async syncPlugins(
		id: number,
		anilistData: ProviderAnimeData,
		bar: ProgressBar,
	): Promise<void> {
		const active = this.activePluginsFor(id);
		if (!active.length) return;

		bar.setStage(active.map((p) => p.name).join("+"));
		const results = await Promise.allSettled(
			active.map((p) => p.sync(String(id), anilistData)),
		);

		for (let j = 0; j < active.length; j++) {
			const plugin = active[j]!;
			const settled = results[j]!;

			if (settled.status === "rejected") {
				log.error(`[${plugin.name.toUpperCase()}] ID ${id}: ${settled.reason}`);
				continue;
			}

			const result = settled.value;
			if (result.status === "unmatched") {
				this.markUnmatched(plugin.name, id);
			} else if (result.status === "error") {
				log.error(
					`[${plugin.name.toUpperCase()}] ID ${id}: ${result.message}`,
				);
			}
		}
	}

	/** Preview plugin results for an ID without writing to DB. */
	async dryPlugins(
		id: number,
		anilistData: ProviderAnimeData,
		bar: ProgressBar,
	): Promise<Record<string, DryPluginEntry>> {
		const active = this.activePluginsFor(id);
		const entry: Record<string, DryPluginEntry> = {};

		for (const plugin of this.plugins) {
			if (this.unmatchedSets.get(plugin.name)?.has(id)) {
				entry[plugin.name] = { status: "skipped", message: "cached unmatched" };
			} else if (!plugin.dryMatch) {
				entry[plugin.name] = {
					status: "skipped",
					message: "no dry-match implementation",
				};
			}
		}

		if (!active.length) return entry;

		bar.setStage(`ID ${id} — ${active.map((p) => p.name).join("+")}`);

		const results = await Promise.allSettled(
			active.map(async (plugin) => {
				if (!plugin.dryMatch) {
					return {
						pluginName: plugin.name,
						result: {
							status: "skipped" as const,
							message: "no dry-match implementation",
						},
					};
				}
				return {
					pluginName: plugin.name,
					result: await plugin.dryMatch(anilistData),
				};
			}),
		);

		for (let j = 0; j < active.length; j++) {
			const plugin = active[j]!;
			const settled = results[j]!;

			if (settled.status === "rejected") {
				entry[plugin.name] = {
					status: "error",
					message:
						settled.reason instanceof Error
							? settled.reason.message
							: String(settled.reason),
				};
			} else {
				entry[settled.value.pluginName] = settled.value.result;
			}
		}

		return entry;
	}

	/**
	 * Core iteration loop — handles the progress bar, rate-limiting between IDs,
	 * and stat accumulation. The per-ID work is provided by the caller.
	 */
	async iterate(
		options: IterateOptions,
		perIdFn: (
			id: number,
			index: number,
			bar: ProgressBar,
		) => Promise<PerIdResult>,
	): Promise<SyncStats> {
		const { ids, startIndex, endIndex, label, onAfterEach } = options;
		const bar = log.progress(endIndex - startIndex, label);
		const stats: SyncStats = { created: 0, updated: 0, failed: 0 };

		for (let i = startIndex; i < endIndex; i++) {
			const id = ids[i]!;
			const { outcome, extra } = await perIdFn(id, i, bar);

			if (outcome === "created") stats.created++;
			else if (outcome === "updated") stats.updated++;
			else stats.failed++;

			bar.tick().setStats({ ...stats, ...extra });

			await onAfterEach?.({ stats: { ...stats }, index: i });

			if (i < endIndex - 1) {
				bar.setStage("waiting…");
				await Bun.sleep(ANILIST_RATE_MS);
			}
		}

		bar.finish();
		return stats;
	}

	/**
	 * Parallel iteration — fetches up to `concurrency` IDs simultaneously, then
	 * processes (upserts + plugins) each sequentially once the whole batch is
	 * fetched. Sleeps `batchSize × rateLimitMs` from the batch start so the
	 * total request budget stays within the AniList rate limit regardless of how
	 * fast the fetches resolve.
	 *
	 * If the failure share in a sliding window of recent fetches exceeds 25%,
	 * concurrency drops to 1 for
	 * `backoffBatches` (default 10) batches, then restores automatically.
	 */
	async iterateParallel<TFetched>(
		options: IterateOptions & { concurrency: number; rateLimitMs?: number },
		fetchFn: (
			id: number,
			index: number,
			reportIssue: (kind: "rate-limit" | "error") => void,
		) => Promise<TFetched>,
		processFn: (
			id: number,
			index: number,
			bar: ProgressBar,
			fetched: TFetched,
		) => Promise<PerIdResult>,
	): Promise<SyncStats> {
		const {
			ids,
			startIndex,
			endIndex,
			label,
			onAfterEach,
			concurrency,
			rateLimitMs = ANILIST_RATE_MS,
		} = options;

		const bar = log.progress(endIndex - startIndex, label);
		const stats: SyncStats = { created: 0, updated: 0, failed: 0 };
		const ctrl = new AdaptiveController(concurrency);
		let i = startIndex;

		while (i < endIndex) {
			const batchSize = ctrl.currentConcurrency;
			const batchEnd = Math.min(i + batchSize, endIndex);
			const batchIds = ids.slice(i, batchEnd);
			const batchIndices = batchIds.map((_, j) => i + j);
			const batchStart = Date.now();

			// Phase 1: parallel fetch from external API
			bar.setStage(`fetching ×${batchIds.length}…`);
			const issueReported = new Set<number>();
			const recordFetchIssue = (
				batchOffset: number,
				kind: "rate-limit" | "error",
			) => {
				issueReported.add(batchOffset);
				const enteredBackoff = ctrl.record(kind);
				if (enteredBackoff) {
					log.warn(
						`External request failures hit threshold — parallel backoff: ${ctrl.statusLabel}`,
					);
				}
			};
			const fetchResults = await Promise.allSettled(
				batchIds.map((id, j) =>
					fetchFn(id, batchIndices[j]!, (kind) => recordFetchIssue(j, kind)),
				),
			);

			for (let j = 0; j < fetchResults.length; j++) {
				const result = fetchResults[j]!;
				if (result.status === "rejected") {
					if (!issueReported.has(j)) {
						const enteredBackoff = ctrl.record(
							isRateLimitError(result.reason) ? "rate-limit" : "error",
						);
						if (enteredBackoff) {
							log.warn(
								`External request failures hit threshold — parallel backoff: ${ctrl.statusLabel}`,
							);
						}
					}
				} else if (!issueReported.has(j)) {
					ctrl.record("ok");
				}
			}

			// Phase 2: sequential DB upsert + downstream sync
			for (let j = 0; j < batchIds.length; j++) {
				const id = batchIds[j]!;
				const idx = batchIndices[j]!;
				const fetched = fetchResults[j]!;
				let outcome: SyncOutcome;
				let extra: Record<string, number> | undefined;

				if (fetched.status === "rejected") {
					log.error(
						`ID ${id}: ${fetched.reason instanceof Error ? fetched.reason.message : String(fetched.reason)}`,
					);
					outcome = "failed";
				} else {
					try {
						const result = await processFn(id, idx, bar, fetched.value);
						outcome = result.outcome;
						extra = result.extra;
					} catch (err) {
						log.error(
							`ID ${id}: ${err instanceof Error ? err.message : String(err)}`,
						);
						outcome = "failed";
					}
				}

				if (outcome === "created") stats.created++;
				else if (outcome === "updated") stats.updated++;
				else stats.failed++;

				bar.tick().setStats({ ...stats, ...extra });
				await onAfterEach?.({ stats: { ...stats }, index: idx });
			}

			ctrl.batchDone();
			i = batchEnd;

			if (i < endIndex) {
				// Budget: batchSize fetches × rateLimitMs each, counting from batch start
				const elapsed = Date.now() - batchStart;
				const sleepMs = Math.max(0, batchIds.length * rateLimitMs - elapsed);
				if (sleepMs > 0) {
					bar.setStage(
						`waiting ${(sleepMs / 1000).toFixed(1)}s… (${ctrl.statusLabel})`,
					);
					await Bun.sleep(sleepMs);
				}
			}
		}

		bar.finish();
		return stats;
	}
}
