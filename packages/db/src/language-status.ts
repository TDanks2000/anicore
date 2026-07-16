import { and, eq, sql } from "drizzle-orm";

import { db } from "./index";
import {
	animeLanguageEvidence,
	animeLanguageStatus,
	episodeLanguageStatus,
	type AnimeLanguageEvidence,
	type AnimeLanguageStatus,
} from "./schema";
import {
	clampConfidence,
	normalizeLanguageCode,
	resolveAnimeStatusFromEvidence,
	type EpisodeLanguageStatusValue,
	type LanguageEvidenceSource,
	type LanguageEvidenceType,
	type LanguageMediaType,
} from "./language-status-scoring";

function evidenceTypeForEpisodeStatus(input: {
	mediaType: LanguageMediaType;
	provider: string;
}): LanguageEvidenceType {
	if (input.provider === "manual") return "manual_verified";
	return input.mediaType === "audio" ? "provider_audio" : "provider_subtitle";
}

function evidenceSourceForProvider(provider: string): LanguageEvidenceSource {
	return provider === "manual" ? "manual" : "provider";
}

function snapshotSourceUrl(provider: string, sourceUrl?: string | null): string {
	return sourceUrl ?? `urn:anicore:episode-language-status:${provider}`;
}

function episodeStatusEvidenceValue(
	statuses: EpisodeLanguageStatusValue[],
): string | null {
	const hasAvailable = statuses.includes("available");
	const hasPartial = statuses.includes("partial");
	const hasMissing = statuses.includes("missing");

	if (hasAvailable && !hasPartial && !hasMissing) return "available";
	if ((hasAvailable || hasPartial) && hasMissing) return "partial";
	if (hasPartial) return "partial";
	if (hasMissing) return "not_available";
	return null;
}

export async function recalculateAnimeLanguageStatus(input: {
	animeId: number;
	languageCode: string;
	mediaType: LanguageMediaType;
}): Promise<AnimeLanguageStatus> {
	const languageCode = normalizeLanguageCode(input.languageCode);

	const [existing] = await db
		.select()
		.from(animeLanguageStatus)
		.where(
			and(
				eq(animeLanguageStatus.animeId, input.animeId),
				eq(animeLanguageStatus.languageCode, languageCode),
				eq(animeLanguageStatus.mediaType, input.mediaType),
			),
		)
		.limit(1);

	if (existing?.isManualOverride) return existing;

	const evidenceRows = await db
		.select()
		.from(animeLanguageEvidence)
		.where(
			and(
				eq(animeLanguageEvidence.animeId, input.animeId),
				eq(animeLanguageEvidence.languageCode, languageCode),
				eq(animeLanguageEvidence.mediaType, input.mediaType),
			),
		);

	const resolved = resolveAnimeStatusFromEvidence(
		evidenceRows.map((item) => ({
			source: item.source as LanguageEvidenceSource,
			evidenceType: item.evidenceType as LanguageEvidenceType,
			value: item.value,
			confidence: item.confidence,
		})),
	);

	const [row] = await db
		.insert(animeLanguageStatus)
		.values({
			animeId: input.animeId,
			languageCode,
			mediaType: input.mediaType,
			status: resolved.status,
			confidence: resolved.confidence,
			isManualOverride: false,
			checkedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: [
				animeLanguageStatus.animeId,
				animeLanguageStatus.languageCode,
				animeLanguageStatus.mediaType,
			],
			set: {
				status: resolved.status,
				confidence: resolved.confidence,
				isManualOverride: false,
				checkedAt: sql`now()`,
				updatedAt: sql`now()`,
			},
			setWhere: eq(animeLanguageStatus.isManualOverride, false),
		})
		.returning();

	if (row) return row;

	const [manualOverride] = await db
		.select()
		.from(animeLanguageStatus)
		.where(
			and(
				eq(animeLanguageStatus.animeId, input.animeId),
				eq(animeLanguageStatus.languageCode, languageCode),
				eq(animeLanguageStatus.mediaType, input.mediaType),
				eq(animeLanguageStatus.isManualOverride, true),
			),
		)
		.limit(1);

	if (!manualOverride) throw new Error("language status upsert returned no row");
	return manualOverride;
}

export async function syncAnimeLanguageEvidenceFromEpisodeStatuses(input: {
	animeId: number;
	languageCode: string;
	mediaType: LanguageMediaType;
	provider?: string | null;
	sourceUrl?: string | null;
}): Promise<{
	evidence: AnimeLanguageEvidence | null;
	status: AnimeLanguageStatus;
}> {
	const languageCode = normalizeLanguageCode(input.languageCode);
	const provider = input.provider?.trim() || "manual";
	const source = evidenceSourceForProvider(provider);
	const evidenceType = evidenceTypeForEpisodeStatus({
		mediaType: input.mediaType,
		provider,
	});
	const sourceUrl = snapshotSourceUrl(provider, input.sourceUrl);

	const episodeRows = await db
		.select({
			status: episodeLanguageStatus.status,
			confidence: episodeLanguageStatus.confidence,
		})
		.from(episodeLanguageStatus)
		.where(
			and(
				eq(episodeLanguageStatus.animeId, input.animeId),
				eq(episodeLanguageStatus.languageCode, languageCode),
				eq(episodeLanguageStatus.mediaType, input.mediaType),
				eq(episodeLanguageStatus.provider, provider),
			),
		);

	const evidenceValue = episodeStatusEvidenceValue(
		episodeRows.map((row) => row.status as EpisodeLanguageStatusValue),
	);

	const evidenceMatch = and(
		eq(animeLanguageEvidence.animeId, input.animeId),
		eq(animeLanguageEvidence.languageCode, languageCode),
		eq(animeLanguageEvidence.mediaType, input.mediaType),
		eq(animeLanguageEvidence.source, source),
		eq(animeLanguageEvidence.evidenceType, evidenceType),
		eq(animeLanguageEvidence.sourceUrl, sourceUrl),
	);

	if (!evidenceValue) {
		await db.delete(animeLanguageEvidence).where(evidenceMatch);
		const status = await recalculateAnimeLanguageStatus({
			animeId: input.animeId,
			languageCode,
			mediaType: input.mediaType,
		});
		return { evidence: null, status };
	}

	const confidence = clampConfidence(
		Math.max(0, ...episodeRows.map((row) => row.confidence)),
	);

	const [updatedEvidence] = await db
		.update(animeLanguageEvidence)
		.set({
			value: evidenceValue,
			confidence,
			updatedAt: sql`now()`,
		})
		.where(evidenceMatch)
		.returning();

	const evidence =
		updatedEvidence ??
		(
			await db
				.insert(animeLanguageEvidence)
				.values({
					animeId: input.animeId,
					languageCode,
					mediaType: input.mediaType,
					source,
					sourceUrl,
					evidenceType,
					value: evidenceValue,
					confidence,
				})
				.returning()
		)[0];

	if (!evidence) throw new Error("language evidence upsert returned no row");

	const status = await recalculateAnimeLanguageStatus({
		animeId: input.animeId,
		languageCode,
		mediaType: input.mediaType,
	});

	return { evidence, status };
}
