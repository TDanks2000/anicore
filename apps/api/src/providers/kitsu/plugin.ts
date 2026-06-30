import type { DryPluginResult, PluginResult, ProviderAnimeData, ProviderPlugin } from "../types";
import { mapKitsuAnime } from "./mapper";
import { fetchKitsuEpisodeData, findKitsuMatch, syncKitsuFromAnilist } from "./sync";

function toHints(data: ProviderAnimeData) {
	return {
		titleRomaji:  data.titleRomaji,
		titleEnglish: data.titleEnglish,
		season:       data.season,
		seasonYear:   data.seasonYear,
		episodeCount: data.episodeCount,
	};
}

export const kitsuPlugin: ProviderPlugin = {
	name: "kitsu",

	async sync(anilistId: string, data: ProviderAnimeData): Promise<PluginResult> {
		try {
			const result = await syncKitsuFromAnilist(anilistId, toHints(data));
			if (result.matched) {
				return { status: "matched", providerId: result.kitsuId, providerSlug: result.kitsuSlug };
			}
			return { status: "unmatched" };
		} catch (err) {
			return { status: "error", message: err instanceof Error ? err.message : String(err) };
		}
	},

	async dryMatch(data: ProviderAnimeData): Promise<DryPluginResult> {
		try {
			const node = await findKitsuMatch(toHints(data));
			if (!node) return { status: "unmatched" };
			return {
				status:       "matched",
				providerId:   node.id,
				providerSlug: node.slug ?? null,
				data:         mapKitsuAnime(node),
				episodes:     await fetchKitsuEpisodeData(node.id),
				episodeCount: node.episodeCount ?? undefined,
			};
		} catch (err) {
			return { status: "error", message: err instanceof Error ? err.message : String(err) };
		}
	},
};
