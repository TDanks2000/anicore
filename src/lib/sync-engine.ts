import { appendUnmatched, loadUnmatched } from "./cache";
import { ANILIST_RATE_MS } from "./anilist-rate-limit";
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
}
