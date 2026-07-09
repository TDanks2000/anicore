import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@anicore/db";
import {
  recalculateAnimeLanguageStatus,
  syncAnimeLanguageEvidenceFromEpisodeStatuses,
} from "@anicore/db/language-status";
import {
  anime,
  animeLanguageEvidence,
  animeLanguageStatus,
  episodeLanguageStatus,
  episodes,
  type AnimeLanguageEvidence,
  type AnimeLanguageStatus,
  type Episode,
  type EpisodeLanguageStatus,
} from "@anicore/db/schema";
import {
  clampConfidence,
  defaultEvidenceConfidence,
  mapLegacyAudioStatusToEpisodeStatus,
  normalizeLanguageCode,
  toLegacyEpisodeAudioResponse,
  type AnimeLanguageStatusValue,
  type EpisodeLanguageStatusValue,
  type LanguageEvidenceSource,
  type LanguageEvidenceType,
  type LanguageMediaType,
  type LegacyAudioStatusValue,
} from "./language-status.scoring";

export interface AnimeLanguageStatusResult {
  animeId: number;
  languageCode: string;
  mediaType: LanguageMediaType;
  status: AnimeLanguageStatusValue;
  confidence: number;
  isManualOverride: boolean;
  notes: string | null;
  checkedAt: Date | null;
  evidence: AnimeLanguageEvidence[];
  episodes: EpisodeLanguageStatus[];
}

export async function getAnimeById(animeId: number) {
  const [row] = await db
    .select({ id: anime.id })
    .from(anime)
    .where(eq(anime.id, animeId))
    .limit(1);

  return row ?? null;
}

export async function getEpisodeById(episodeId: number): Promise<Episode | null> {
  const [row] = await db
    .select()
    .from(episodes)
    .where(eq(episodes.id, episodeId))
    .limit(1);

  return row ?? null;
}

export async function listAnimeLanguageStatus(animeId: number, filters?: {
  languageCode?: string;
  mediaType?: LanguageMediaType;
}) {
  const conditions = [eq(animeLanguageStatus.animeId, animeId)];

  if (filters?.languageCode) {
    conditions.push(
      eq(animeLanguageStatus.languageCode, normalizeLanguageCode(filters.languageCode)),
    );
  }

  if (filters?.mediaType) {
    conditions.push(eq(animeLanguageStatus.mediaType, filters.mediaType));
  }

  const statusRows = await db
    .select()
    .from(animeLanguageStatus)
    .where(and(...conditions))
    .orderBy(asc(animeLanguageStatus.languageCode), asc(animeLanguageStatus.mediaType));

  const evidenceConditions = [eq(animeLanguageEvidence.animeId, animeId)];

  if (filters?.languageCode) {
    evidenceConditions.push(
      eq(animeLanguageEvidence.languageCode, normalizeLanguageCode(filters.languageCode)),
    );
  }

  if (filters?.mediaType) {
    evidenceConditions.push(eq(animeLanguageEvidence.mediaType, filters.mediaType));
  }

  const evidenceRows = await db
    .select()
    .from(animeLanguageEvidence)
    .where(and(...evidenceConditions))
    .orderBy(desc(animeLanguageEvidence.confidence), desc(animeLanguageEvidence.createdAt));

  const episodeConditions = [eq(episodeLanguageStatus.animeId, animeId)];

  if (filters?.languageCode) {
    episodeConditions.push(
      eq(episodeLanguageStatus.languageCode, normalizeLanguageCode(filters.languageCode)),
    );
  }

  if (filters?.mediaType) {
    episodeConditions.push(eq(episodeLanguageStatus.mediaType, filters.mediaType));
  }

  const episodeRows = await db
    .select()
    .from(episodeLanguageStatus)
    .where(and(...episodeConditions))
    .orderBy(
      asc(episodeLanguageStatus.episodeNumber),
      asc(episodeLanguageStatus.languageCode),
      asc(episodeLanguageStatus.mediaType),
    );

  return {
    animeId,
    statuses: statusRows,
    evidence: evidenceRows,
    episodes: episodeRows,
  };
}

export async function getResolvedAnimeLanguageStatus(input: {
  animeId: number;
  languageCode: string;
  mediaType: LanguageMediaType;
}): Promise<AnimeLanguageStatusResult> {
  const languageCode = normalizeLanguageCode(input.languageCode);

  const [statusRow, evidenceRows, episodeRows] = await Promise.all([
    db
      .select()
      .from(animeLanguageStatus)
      .where(
        and(
          eq(animeLanguageStatus.animeId, input.animeId),
          eq(animeLanguageStatus.languageCode, languageCode),
          eq(animeLanguageStatus.mediaType, input.mediaType),
        ),
      )
      .limit(1),
    db
      .select()
      .from(animeLanguageEvidence)
      .where(
        and(
          eq(animeLanguageEvidence.animeId, input.animeId),
          eq(animeLanguageEvidence.languageCode, languageCode),
          eq(animeLanguageEvidence.mediaType, input.mediaType),
        ),
      )
      .orderBy(desc(animeLanguageEvidence.confidence), desc(animeLanguageEvidence.createdAt)),
    db
      .select()
      .from(episodeLanguageStatus)
      .where(
        and(
          eq(episodeLanguageStatus.animeId, input.animeId),
          eq(episodeLanguageStatus.languageCode, languageCode),
          eq(episodeLanguageStatus.mediaType, input.mediaType),
        ),
      )
      .orderBy(asc(episodeLanguageStatus.episodeNumber)),
  ]);

  const row = statusRow[0];
  return {
    animeId: input.animeId,
    languageCode,
    mediaType: input.mediaType,
    status: (row?.status ?? "unknown") as AnimeLanguageStatusValue,
    confidence: row?.confidence ?? 0,
    isManualOverride: row?.isManualOverride ?? false,
    notes: row?.notes ?? null,
    checkedAt: row?.checkedAt ?? null,
    evidence: evidenceRows,
    episodes: episodeRows,
  };
}

export async function addAnimeLanguageEvidence(input: {
  animeId: number;
  languageCode: string;
  mediaType: LanguageMediaType;
  source: LanguageEvidenceSource;
  sourceUrl?: string | null;
  evidenceType: LanguageEvidenceType;
  value: string;
  confidence?: number | null;
}) {
  const languageCode = normalizeLanguageCode(input.languageCode);
  const confidence = clampConfidence(
    input.confidence ??
      defaultEvidenceConfidence({
        source: input.source,
        evidenceType: input.evidenceType,
        sourceUrl: input.sourceUrl,
      }),
  );

  const [evidence] = await db
    .insert(animeLanguageEvidence)
    .values({
      animeId: input.animeId,
      languageCode,
      mediaType: input.mediaType,
      source: input.source,
      sourceUrl: input.sourceUrl,
      evidenceType: input.evidenceType,
      value: input.value,
      confidence,
    })
    .returning();

  if (!evidence) throw new Error("language evidence insert returned no row");

  const status = await recalculateAnimeLanguageStatus({
    animeId: input.animeId,
    languageCode,
    mediaType: input.mediaType,
  });

  return { evidence, status };
}

export async function applyAnimeLanguageOverride(input: {
  animeId: number;
  languageCode: string;
  mediaType: LanguageMediaType;
  status: AnimeLanguageStatusValue;
  confidence?: number | null;
  notes?: string | null;
}) {
  const languageCode = normalizeLanguageCode(input.languageCode);
  const confidence = clampConfidence(input.confidence ?? 100);

  const [row] = await db
    .insert(animeLanguageStatus)
    .values({
      animeId: input.animeId,
      languageCode,
      mediaType: input.mediaType,
      status: input.status,
      confidence,
      isManualOverride: true,
      notes: input.notes,
      checkedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        animeLanguageStatus.animeId,
        animeLanguageStatus.languageCode,
        animeLanguageStatus.mediaType,
      ],
      set: {
        status: input.status,
        confidence,
        isManualOverride: true,
        notes: input.notes,
        checkedAt: sql`now()`,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  if (!row) throw new Error("language override upsert returned no row");
  return row;
}

export async function upsertEpisodeLanguageStatus(input: {
  animeId: number;
  episodeNumber: number;
  languageCode: string;
  mediaType: LanguageMediaType;
  status: EpisodeLanguageStatusValue;
  provider?: string | null;
  confidence?: number | null;
  checkedAt?: Date | null;
}) {
  const languageCode = normalizeLanguageCode(input.languageCode);
  const provider = input.provider?.trim() || "manual";
  const confidence = clampConfidence(input.confidence ?? 75);

  const [row] = await db
    .insert(episodeLanguageStatus)
    .values({
      animeId: input.animeId,
      episodeNumber: input.episodeNumber,
      languageCode,
      mediaType: input.mediaType,
      status: input.status,
      provider,
      confidence,
      checkedAt: input.checkedAt ?? new Date(),
    })
    .onConflictDoUpdate({
      target: [
        episodeLanguageStatus.animeId,
        episodeLanguageStatus.episodeNumber,
        episodeLanguageStatus.languageCode,
        episodeLanguageStatus.mediaType,
        episodeLanguageStatus.provider,
      ],
      set: {
        status: input.status,
        confidence,
        checkedAt: input.checkedAt ?? sql`now()`,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  if (!row) throw new Error("episode language status upsert returned no row");
  await syncAnimeLanguageEvidenceFromEpisodeStatuses({
    animeId: row.animeId,
    languageCode: row.languageCode,
    mediaType: row.mediaType as LanguageMediaType,
    provider: row.provider,
  });
  return row;
}

export async function getEpisodeLanguageStatusesForEpisode(episodeId: number) {
  const episode = await getEpisodeById(episodeId);
  if (!episode) return null;

  const rows = await db
    .select()
    .from(episodeLanguageStatus)
    .where(
      and(
        eq(episodeLanguageStatus.animeId, episode.animeId),
        eq(episodeLanguageStatus.episodeNumber, episode.number),
      ),
    )
    .orderBy(
      asc(episodeLanguageStatus.mediaType),
      asc(episodeLanguageStatus.languageCode),
      asc(episodeLanguageStatus.provider),
    );

  return { episode, rows };
}

export async function upsertLegacyEpisodeAudioStatus(input: {
  episodeId: number;
  audioMode: "original" | "sub" | "dub";
  locale?: string | null;
  status?: LegacyAudioStatusValue | null;
  sourceProvider?: string | null;
}) {
  const episode = await getEpisodeById(input.episodeId);
  if (!episode) return null;

  const row = await upsertEpisodeLanguageStatus({
    animeId: episode.animeId,
    episodeNumber: episode.number,
    languageCode: input.locale ?? (input.audioMode === "original" ? "ja" : "en"),
    mediaType: "audio",
    status: mapLegacyAudioStatusToEpisodeStatus(input.status ?? "unknown"),
    provider: input.sourceProvider ?? "manual",
    confidence: input.sourceProvider === "manual" ? 100 : 75,
  });

  return toLegacyEpisodeAudioResponse(episode, [row])[0] ?? null;
}

export async function listLanguageStatusReviewQueue(limit: number) {
  return db
    .select()
    .from(animeLanguageStatus)
    .where(
      and(
        inArray(animeLanguageStatus.status, ["unknown", "possible"]),
        eq(animeLanguageStatus.isManualOverride, false),
      ),
    )
    .orderBy(asc(animeLanguageStatus.confidence), desc(animeLanguageStatus.updatedAt))
    .limit(limit);
}
