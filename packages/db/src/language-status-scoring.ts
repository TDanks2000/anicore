export const languageMediaTypes = ["audio", "subtitle"] as const;
export type LanguageMediaType = (typeof languageMediaTypes)[number];

export const animeLanguageStatuses = [
	"unknown",
	"possible",
	"likely",
	"confirmed",
	"partial",
	"not_available",
] as const;
export type AnimeLanguageStatusValue = (typeof animeLanguageStatuses)[number];

export const episodeLanguageStatuses = [
	"unknown",
	"available",
	"missing",
	"partial",
] as const;
export type EpisodeLanguageStatusValue =
	(typeof episodeLanguageStatuses)[number];

export const languageEvidenceSources = [
	"ann",
	"official_site",
	"provider",
	"home_video",
	"community",
	"manual",
	"other",
] as const;
export type LanguageEvidenceSource = (typeof languageEvidenceSources)[number];

export const languageEvidenceTypes = [
	"voice_cast",
	"provider_audio",
	"provider_subtitle",
	"official_announcement",
	"home_video_release",
	"manual_verified",
	"community_submission",
	"other",
] as const;
export type LanguageEvidenceType = (typeof languageEvidenceTypes)[number];

export type LegacyAudioStatusValue =
	| "unknown"
	| "unavailable"
	| "available"
	| "partial";

export function clampConfidence(confidence: number): number {
	if (!Number.isFinite(confidence)) return 0;
	return Math.max(0, Math.min(100, Math.round(confidence)));
}

export function normalizeLanguageCode(languageCode: string): string {
	return languageCode.trim().toLowerCase();
}

export function defaultEvidenceConfidence(input: {
	source: LanguageEvidenceSource;
	evidenceType: LanguageEvidenceType;
	sourceUrl?: string | null;
}): number {
	if (input.source === "manual" && input.evidenceType === "manual_verified") {
		return 100;
	}

	if (
		input.evidenceType === "provider_audio" ||
		input.evidenceType === "provider_subtitle" ||
		input.evidenceType === "official_announcement"
	) {
		return 90;
	}

	if (
		input.evidenceType === "home_video_release" ||
		input.evidenceType === "voice_cast"
	) {
		return 75;
	}

	if (input.evidenceType === "community_submission" && input.sourceUrl) {
		return 50;
	}

	return 20;
}

export function resolveStatusFromConfidence(
	confidence: number,
): Exclude<AnimeLanguageStatusValue, "partial" | "not_available"> {
	const score = clampConfidence(confidence);
	if (score >= 90) return "confirmed";
	if (score >= 65) return "likely";
	if (score >= 40) return "possible";
	return "unknown";
}

export function isExplicitNegativeEvidence(input: {
	source: LanguageEvidenceSource;
	evidenceType: LanguageEvidenceType;
	value: string;
	confidence: number;
}): boolean {
	if (input.source === "community" || input.source === "other") return false;
	if (clampConfidence(input.confidence) < 75) return false;

	const value = input.value.trim().toLowerCase();
	return [
		"not_available",
		"unavailable",
		"missing",
		"no_dub",
		"no_subtitle",
		"no_subtitles",
		"no_audio",
		"no_language_track",
		"explicitly_not_available",
	].includes(value);
}

export function isPartialEvidence(input: { value: string; confidence: number }) {
	const value = input.value.trim().toLowerCase();
	return value === "partial" && clampConfidence(input.confidence) >= 75;
}

export function resolveAnimeStatusFromEvidence(
	evidence: Array<{
		source: LanguageEvidenceSource;
		evidenceType: LanguageEvidenceType;
		value: string;
		confidence: number;
	}>,
): { status: AnimeLanguageStatusValue; confidence: number } {
	if (evidence.length === 0) {
		return { status: "unknown", confidence: 0 };
	}

	const reliableNegative = evidence
		.filter(isExplicitNegativeEvidence)
		.sort((a, b) => clampConfidence(b.confidence) - clampConfidence(a.confidence))[0];

	const partialEvidence = evidence
		.filter(isPartialEvidence)
		.sort((a, b) => clampConfidence(b.confidence) - clampConfidence(a.confidence))[0];

	const positiveEvidence = evidence
		.filter((item) => !isExplicitNegativeEvidence(item) && !isPartialEvidence(item))
		.sort((a, b) => clampConfidence(b.confidence) - clampConfidence(a.confidence))[0];

	const negativeConfidence = reliableNegative
		? clampConfidence(reliableNegative.confidence)
		: -1;
	const partialConfidence = partialEvidence
		? clampConfidence(partialEvidence.confidence)
		: -1;
	const positiveConfidence = positiveEvidence
		? clampConfidence(positiveEvidence.confidence)
		: -1;

	if (
		negativeConfidence >= 75 &&
		negativeConfidence >= partialConfidence &&
		negativeConfidence >= positiveConfidence
	) {
		return { status: "not_available", confidence: negativeConfidence };
	}

	if (partialConfidence >= 75 && partialConfidence >= positiveConfidence) {
		return { status: "partial", confidence: partialConfidence };
	}

	if (!positiveEvidence) {
		return { status: "unknown", confidence: 0 };
	}

	return {
		status: resolveStatusFromConfidence(positiveConfidence),
		confidence: positiveConfidence,
	};
}

export function resolveAnimeStatus(input: {
	manualOverride?: {
		status: AnimeLanguageStatusValue;
		confidence: number;
	} | null;
	evidence: Parameters<typeof resolveAnimeStatusFromEvidence>[0];
}): { status: AnimeLanguageStatusValue; confidence: number } {
	if (input.manualOverride) {
		return {
			status: input.manualOverride.status,
			confidence: clampConfidence(input.manualOverride.confidence),
		};
	}

	return resolveAnimeStatusFromEvidence(input.evidence);
}

export function mapLegacyAudioStatusToEpisodeStatus(
	status: LegacyAudioStatusValue,
): EpisodeLanguageStatusValue {
	if (status === "unavailable") return "missing";
	return status;
}

export interface LegacyEpisodeLike {
	id: number;
}

export interface EpisodeLanguageStatusLike {
	languageCode: string;
	mediaType: LanguageMediaType;
	status: EpisodeLanguageStatusValue;
	provider: string;
}

export function toLegacyEpisodeAudioResponse<
	T extends EpisodeLanguageStatusLike,
>(episode: LegacyEpisodeLike, rows: T[]) {
	return rows
		.filter((row) => row.mediaType === "audio")
		.map((row) => ({
			...row,
			episodeId: episode.id,
			audioMode: row.languageCode === "ja" ? "original" : "dub",
			locale: row.languageCode,
			status: row.status === "missing" ? "unavailable" : row.status,
			sourceProvider: row.provider,
		}));
}
