export type ProviderName =
	| "anilist"
	| "kitsu"
	| "thetvdb"
	| "mal"
	| "tmdb"
	| "simkl"
	| "anisearch"
	| "animeplanet"
	| "animeschedule"
	| "other";

export interface PluginResult {
	status: "matched" | "unmatched" | "error";
	providerId?: string;
	providerSlug?: string | null;
	message?: string;
}

export interface DryPluginResult extends PluginResult {
	data?: ProviderAnimeData;
	episodes?: ProviderEpisodeData[];
	episodeCount?: number;
}

export interface ProviderPlugin {
	readonly name: ProviderName;
	sync(
		anilistId: string,
		anilistData: ProviderAnimeData,
	): Promise<PluginResult>;
	/** Attempt a match without writing anything to the database. */
	dryMatch?(anilistData: ProviderAnimeData): Promise<DryPluginResult>;
}

export interface ProviderStudio {
	name: string;
	isMain: boolean;
	isAnimationStudio: boolean;
	anilistStudioId?: number | null;
}

export interface ProviderTag {
	name: string;
	category?: string | null;
	rank?: number | null;
	isGeneralSpoiler?: boolean;
	isMediaSpoiler?: boolean;
	isAdult?: boolean;
}

export interface ProviderExternalLink {
	site: string;
	url: string;
	type?: string | null;
	language?: string | null;
	color?: string | null;
	icon?: string | null;
}

export interface ProviderRelation {
	anilistId: number;
	relationType: string;
}

export interface ProviderEpisodeData {
	number: number;
	title?: string | null;
	titleRomaji?: string | null;
	titleEnglish?: string | null;
	description?: string | null;
	airDate?: string | null;
	lengthMinutes?: number | null;
	thumbnail?: string | null;
	providerId: string;
	providerSlug?: string | null;
	providerUrl?: string | null;
	providerEpisodeNumber?: string | null;
}

export interface ProviderAnimeData {
	provider: ProviderName;
	providerId: string;
	providerSlug?: string | null;
	providerUrl?: string | null;

	titleRomaji: string;
	titleEnglish?: string | null;
	titleNative?: string | null;
	titleUserPreferred?: string | null;

	description?: string | null;
	format?: string | null;
	status?: string | null;
	source?: string | null;
	season?: string | null;
	seasonYear?: number | null;
	startDate?: string | null;
	endDate?: string | null;
	episodeCount?: number | null;
	durationMinutes?: number | null;
	countryOfOrigin?: string | null;
	isAdult?: boolean | null;

	genres?: string[];
	synonyms?: string[];

	averageScore?: number | null;
	meanScore?: number | null;
	popularity?: number | null;
	favourites?: number | null;
	trending?: number | null;

	coverImage?: string | null;
	coverImageColor?: string | null;
	bannerImage?: string | null;

	trailerVideoId?: string | null;
	trailerSite?: string | null;
	trailerThumbnail?: string | null;

	nextEpisodeNumber?: number | null;
	nextEpisodeAirsAt?: number | null;

	hashtag?: string | null;

	studios?: ProviderStudio[];
	tags?: ProviderTag[];
	externalLinks?: ProviderExternalLink[];
	relations?: ProviderRelation[];
}
