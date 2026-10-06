import { db, readDb } from "@anicore/db";
import type { EpisodeKind } from "@anicore/db/enums";
import { syncAnimeLanguageEvidenceFromEpisodeStatuses } from "@anicore/db/language-status";
import { episodeLanguageStatus, episodes } from "@anicore/db/schema";
import { and, asc, eq } from "drizzle-orm";

import { conflict, isForeignKeyViolation, isUniqueViolation, notFound } from "../../lib/errors";
import {
  type EpisodeLanguageStatusValue,
  type LanguageMediaType,
  type LegacyAudioStatusValue,
  mapLegacyAudioStatusToEpisodeStatus,
  normalizeLanguageCode,
  toLegacyEpisodeAudioResponse,
} from "../language-status/language-status.scoring";
import {
  type EpisodeMappingInput,
  insertEpisodeMappings,
  listEpisodeMappings,
  prepareNewEpisodeMappings,
} from "../mappings/mappings.service";

export async function listEpisodes(query: { limit: number; offset: number }) {
  return readDb
    .select()
    .from(episodes)
    .orderBy(asc(episodes.id))
    .limit(query.limit)
    .offset(query.offset);
}

export async function getEpisode(id: number) {
  const [row] = await readDb.select().from(episodes).where(eq(episodes.id, id)).limit(1);
  if (!row) throw notFound("Episode not found");
  return row;
}

function listLanguageStatusesForEpisode(episode: { animeId: number; number: number }) {
  return readDb
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
}

export async function getEpisodeFull(id: number) {
  const episode = await getEpisode(id);
  const [mappings, languageStatuses] = await Promise.all([
    listEpisodeMappings(id),
    listLanguageStatusesForEpisode(episode),
  ]);
  return {
    ...episode,
    mappings,
    languageStatuses,
    audioStatuses: toLegacyEpisodeAudioResponse(episode, languageStatuses),
  };
}

export async function listMappingsForEpisode(id: number) {
  await getEpisode(id);
  return listEpisodeMappings(id);
}

export async function getEpisodeAudio(id: number) {
  const episode = await getEpisode(id);
  return toLegacyEpisodeAudioResponse(episode, await listLanguageStatusesForEpisode(episode));
}

export interface CreateEpisodeInput {
  animeId: number;
  number: number;
  displayNumber?: string;
  sortNumber?: number;
  seasonNumber?: number;
  absoluteNumber?: number;
  title?: string;
  titleRomaji?: string;
  titleEnglish?: string;
  titleNative?: string;
  synopsis?: string;
  airDate?: string;
  thumbnail?: string;
  lengthMinutes?: number;
  kind?: EpisodeKind;
  mappings?: EpisodeMappingInput[];
  languageStatuses?: Array<{
    languageCode: string;
    mediaType: LanguageMediaType;
    status?: EpisodeLanguageStatusValue;
    provider?: string;
    confidence?: number;
  }>;
  audioStatuses?: Array<{
    audioMode: "original" | "sub" | "dub";
    locale?: string;
    status?: LegacyAudioStatusValue;
    sourceProvider?: string;
  }>;
}

const defaultConfidence = (provider: string) => (provider === "manual" ? 100 : 75);

function languageStatusRows(input: CreateEpisodeInput) {
  const explicit = (input.languageStatuses ?? []).map((status) => {
    const provider = status.provider?.trim() || "manual";
    return {
      animeId: input.animeId,
      episodeNumber: input.number,
      languageCode: normalizeLanguageCode(status.languageCode),
      mediaType: status.mediaType,
      status: status.status ?? ("unknown" as const),
      provider,
      confidence: status.confidence ?? defaultConfidence(provider),
    };
  });

  const legacy = (input.audioStatuses ?? []).map((status) => {
    const provider = status.sourceProvider?.trim() || "manual";
    return {
      animeId: input.animeId,
      episodeNumber: input.number,
      languageCode: normalizeLanguageCode(
        status.locale ?? (status.audioMode === "original" ? "ja" : "en"),
      ),
      mediaType: "audio" as const,
      status: mapLegacyAudioStatusToEpisodeStatus(status.status ?? "unknown"),
      provider,
      confidence: defaultConfidence(provider),
    };
  });

  return [...explicit, ...legacy];
}

export async function createEpisode(input: CreateEpisodeInput) {
  const mappings = prepareNewEpisodeMappings(input.mappings ?? []);
  const languageStatuses = languageStatusRows(input);

  const created = await db
    .transaction(async (tx) => {
      const [row] = await tx
        .insert(episodes)
        .values({
          animeId: input.animeId,
          number: input.number,
          displayNumber: input.displayNumber ?? String(input.number),
          sortNumber: input.sortNumber ?? input.number,
          seasonNumber: input.seasonNumber,
          absoluteNumber: input.absoluteNumber,
          title: input.title,
          titleRomaji: input.titleRomaji,
          titleEnglish: input.titleEnglish,
          titleNative: input.titleNative,
          synopsis: input.synopsis,
          airDate: input.airDate,
          thumbnail: input.thumbnail,
          lengthMinutes: input.lengthMinutes,
          kind: input.kind ?? "normal",
        })
        .returning();

      await insertEpisodeMappings(tx, row!, mappings);
      if (languageStatuses.length) {
        await tx.insert(episodeLanguageStatus).values(languageStatuses);
      }
      return row!;
    })
    .catch((error: unknown) => {
      if (isForeignKeyViolation(error)) throw notFound("Anime not found");
      if (isUniqueViolation(error)) throw conflict("Episode or language status already exists");
      throw error;
    });

  // Episode-level statuses feed the anime-level evidence once per source.
  const evidenceKeys = new Map(
    languageStatuses.map((status) => [
      `${status.languageCode}:${status.mediaType}:${status.provider}`,
      status,
    ]),
  );
  for (const status of evidenceKeys.values()) {
    await syncAnimeLanguageEvidenceFromEpisodeStatuses({
      animeId: status.animeId,
      languageCode: status.languageCode,
      mediaType: status.mediaType,
      provider: status.provider,
    });
  }

  return created;
}
