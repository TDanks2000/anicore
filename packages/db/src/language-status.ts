import { and, eq, inArray, or, sql } from "drizzle-orm";

import { db } from "./index";
import {
  clampConfidence,
  type EpisodeLanguageStatusValue,
  type LanguageEvidenceSource,
  type LanguageEvidenceType,
  type LanguageMediaType,
  normalizeLanguageCode,
  resolveAnimeStatusFromEvidence,
} from "./language-status-scoring";
import {
  type AnimeLanguageEvidence,
  type AnimeLanguageStatus,
  anime,
  animeLanguageEvidence,
  animeLanguageStatus,
  episodeLanguageStatus,
  episodes,
} from "./schema";

type LanguageDatabase = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

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

export function episodeStatusEvidenceValue(statuses: EpisodeLanguageStatusValue[]): string | null {
  const hasAvailable = statuses.includes("available");
  const hasPartial = statuses.includes("partial");
  const hasMissing = statuses.includes("missing");

  if (hasAvailable && !hasPartial && !hasMissing && !statuses.includes("unknown"))
    return "available";
  if (hasAvailable && statuses.includes("unknown")) return "partial";
  if ((hasAvailable || hasPartial) && hasMissing) return "partial";
  if (hasPartial) return "partial";
  if (hasMissing && !statuses.includes("unknown")) return "not_available";
  return null;
}

export async function recalculateAnimeLanguageStatus(
  input: {
    animeId: number;
    languageCode: string;
    mediaType: LanguageMediaType;
  },
  executor: LanguageDatabase = db,
): Promise<AnimeLanguageStatus> {
  const languageCode = normalizeLanguageCode(input.languageCode);

  const [existing] = await executor
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

  const evidenceRows = await executor
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

  const [row] = await executor
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
        checkedAt: new Date(),
        updatedAt: new Date(),
      },
      setWhere: eq(animeLanguageStatus.isManualOverride, false),
    })
    .returning();

  if (row) return row;

  const [manualOverride] = await executor
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
      episodeNumber: episodeLanguageStatus.episodeNumber,
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

  const canonicalEpisodes = await db
    .select({ number: episodes.number })
    .from(episodes)
    .where(eq(episodes.animeId, input.animeId));
  const [animeRow] = await db
    .select({ episodeCount: anime.episodeCount, status: anime.status })
    .from(anime)
    .where(eq(anime.id, input.animeId));
  const canonicalNumbers = new Set(canonicalEpisodes.map((row) => row.number));
  const relevant = episodeRows.filter((row) => canonicalNumbers.has(row.episodeNumber));
  const values = relevant.map((row) => row.status as EpisodeLanguageStatusValue);
  if (
    canonicalEpisodes.length > relevant.length ||
    (animeRow?.episodeCount ?? 0) > relevant.length ||
    animeRow?.status !== "FINISHED"
  )
    values.push("unknown");
  const evidenceValue = episodeStatusEvidenceValue(values);

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
    Math.min(...relevant.filter((row) => row.status !== "unknown").map((row) => row.confidence)),
  );

  const [updatedEvidence] = await db
    .update(animeLanguageEvidence)
    .set({
      value: evidenceValue,
      confidence,
      updatedAt: new Date(),
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

export interface ProviderLanguageAssertion {
  languageCode: string;
  mediaType: LanguageMediaType;
  evidenceType: LanguageEvidenceType;
  sourceUrl: string;
  value: string;
  confidence: number;
}

/** Replace an owned provider snapshot, including retired routes, in one transaction. */
export async function replaceProviderLanguageSnapshot(input: {
  animeId: number;
  provider: string;
  sourceUrlPrefixes: string[];
  evidenceTypes: LanguageEvidenceType[];
  evidence: ProviderLanguageAssertion[];
  episodes?: Array<{
    episodeNumber: number;
    languageCode: string;
    mediaType: LanguageMediaType;
    status: EpisodeLanguageStatusValue;
    confidence: number;
  }>;
}): Promise<void> {
  if (
    !input.sourceUrlPrefixes.length ||
    input.sourceUrlPrefixes.some((prefix) => !prefix.trim()) ||
    !input.evidenceTypes.length
  )
    throw new Error("Provider snapshot requires an explicit ownership scope");
  const ownsUrl = (url: string) => input.sourceUrlPrefixes.some((prefix) => url.startsWith(prefix));
  const assertions = input.evidence.map((item) => {
    if (!ownsUrl(item.sourceUrl) || !input.evidenceTypes.includes(item.evidenceType))
      throw new Error("Evidence is outside the provider snapshot scope");
    return {
      ...item,
      languageCode: normalizeLanguageCode(item.languageCode),
      confidence: clampConfidence(item.confidence),
    };
  });
  const episodeRows = (input.episodes ?? []).map((item) => ({
    ...item,
    languageCode: normalizeLanguageCode(item.languageCode),
    confidence: clampConfidence(item.confidence),
  }));
  await db.transaction(async (tx) => {
    const scope = and(
      eq(animeLanguageEvidence.animeId, input.animeId),
      eq(animeLanguageEvidence.source, "provider"),
      inArray(animeLanguageEvidence.evidenceType, input.evidenceTypes),
      or(
        ...input.sourceUrlPrefixes.map(
          (prefix) =>
            sql`substr(${animeLanguageEvidence.sourceUrl}, 1, ${prefix.length}) = ${prefix}`,
        ),
      ),
    );
    const oldEvidence = await tx.select().from(animeLanguageEvidence).where(scope);
    const oldEpisodes = await tx
      .select()
      .from(episodeLanguageStatus)
      .where(
        and(
          eq(episodeLanguageStatus.animeId, input.animeId),
          eq(episodeLanguageStatus.provider, input.provider),
        ),
      );
    const keys = new Map(
      [...oldEvidence, ...oldEpisodes, ...assertions, ...episodeRows].map((item) => [
        `${item.languageCode}:${item.mediaType}`,
        { languageCode: item.languageCode, mediaType: item.mediaType },
      ]),
    );
    await tx.delete(animeLanguageEvidence).where(scope);
    await tx
      .delete(episodeLanguageStatus)
      .where(
        and(
          eq(episodeLanguageStatus.animeId, input.animeId),
          eq(episodeLanguageStatus.provider, input.provider),
        ),
      );
    if (assertions.length)
      await tx.insert(animeLanguageEvidence).values(
        assertions.map((item) => ({
          ...item,
          animeId: input.animeId,
          source: "provider" as const,
        })),
      );
    if (episodeRows.length) {
      const canonical = new Set(
        (
          await tx
            .select({ number: episodes.number })
            .from(episodes)
            .where(eq(episodes.animeId, input.animeId))
        ).map((row) => row.number),
      );
      if (episodeRows.some((row) => !canonical.has(row.episodeNumber)))
        throw new Error("Provider snapshot contains a non-canonical episode");
      for (let offset = 0; offset < episodeRows.length; offset += 100)
        await tx.insert(episodeLanguageStatus).values(
          episodeRows.slice(offset, offset + 100).map((item) => ({
            ...item,
            animeId: input.animeId,
            provider: input.provider,
            checkedAt: new Date(),
          })),
        );
    }
    for (const key of keys.values())
      await recalculateAnimeLanguageStatus({ animeId: input.animeId, ...key }, tx);
  });
}
