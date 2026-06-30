import { and, eq, inArray, or, sql } from "drizzle-orm";

import { db } from "../db";
import {
  anime,
  animeExternalLinks,
  animeMappings,
  animeRelationLinks,
  animeStudioLinks,
  animeTagLinks,
  studios,
  tags,
} from "../db/schema";
import { toJsonArray } from "../lib/json";
import { slugify } from "../lib/slug";
import {
  dedupeProviderStudios,
  dedupeProviderTags,
  normalizeEntityName,
} from "./normalize";
import type { ProviderAnimeData } from "./types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function slugTaken(slug: string): Promise<boolean> {
  const [row] = await db.select({ id: anime.id }).from(anime).where(eq(anime.slug, slug)).limit(1);
  return !!row;
}

async function resolveSlug(base: string, providerId: string): Promise<string> {
  const candidate = slugify(base) || String(providerId);
  if (!(await slugTaken(candidate))) return candidate;
  const withProvider = `${candidate}-${providerId}`;
  if (!(await slugTaken(withProvider))) return withProvider;
  return `${withProvider}-${Date.now()}`;
}

function buildAnimeFields(data: ProviderAnimeData) {
  return {
    titleRomaji: data.titleRomaji,
    titleEnglish: data.titleEnglish ?? null,
    titleNative: data.titleNative ?? null,
    titleUserPreferred: data.titleUserPreferred ?? null,
    description: data.description ?? null,
    format: data.format ?? null,
    status: data.status ?? null,
    source: data.source ?? null,
    season: data.season ?? null,
    seasonYear: data.seasonYear ?? null,
    startDate: data.startDate ?? null,
    endDate: data.endDate ?? null,
    episodeCount: data.episodeCount ?? null,
    durationMinutes: data.durationMinutes ?? null,
    countryOfOrigin: data.countryOfOrigin ?? null,
    isAdult: data.isAdult ?? false,
    genresJson: toJsonArray(data.genres),
    synonymsJson: toJsonArray(data.synonyms),
    averageScore: data.averageScore ?? null,
    meanScore: data.meanScore ?? null,
    popularity: data.popularity ?? null,
    favourites: data.favourites ?? null,
    trending: data.trending ?? null,
    coverImage: data.coverImage ?? null,
    coverImageColor: data.coverImageColor ?? null,
    bannerImage: data.bannerImage ?? null,
    trailerVideoId: data.trailerVideoId ?? null,
    trailerSite: data.trailerSite ?? null,
    trailerThumbnail: data.trailerThumbnail ?? null,
    nextEpisodeNumber: data.nextEpisodeNumber ?? null,
    nextEpisodeAirsAt: data.nextEpisodeAirsAt ?? null,
    hashtag: data.hashtag ?? null,
  };
}

async function upsertRelatedData(
  animeId: number,
  data: ProviderAnimeData,
  tx: Tx,
): Promise<void> {
  // Studios — replace on every sync since the set is authoritative
  if (data.studios !== undefined) {
    await tx.delete(animeStudioLinks).where(eq(animeStudioLinks.animeId, animeId));
    const studioData = dedupeProviderStudios(data.studios);
    if (studioData.length) {
      const names = studioData.map((studio) => normalizeEntityName(studio.name));
      const anilistIds = studioData
        .map((studio) => studio.anilistStudioId)
        .filter((id): id is number => id !== null && id !== undefined);

      const existingStudios = await tx.select().from(studios).where(
        or(
          inArray(studios.normalizedName, names),
          anilistIds.length ? inArray(studios.anilistStudioId, anilistIds) : sql`false`,
        ),
      );

      const byNormalizedName = new Map(
        existingStudios.map((studio) => [studio.normalizedName, studio]),
      );
      const byAnilistId = new Map(
        existingStudios
          .filter((studio) => studio.anilistStudioId !== null)
          .map((studio) => [studio.anilistStudioId!, studio]),
      );

      const linkByStudioId = new Map<number, { animeId: number; studioId: number; isMain: boolean }>();

      for (const studioDataRow of studioData) {
        const normalizedName = normalizeEntityName(studioDataRow.name);
        let studioRow =
          (studioDataRow.anilistStudioId != null
            ? byAnilistId.get(studioDataRow.anilistStudioId)
            : undefined) ?? byNormalizedName.get(normalizedName);

        if (!studioRow) {
          [studioRow] = await tx
            .insert(studios)
            .values({
              name: studioDataRow.name,
              normalizedName,
              isAnimationStudio: studioDataRow.isAnimationStudio,
              anilistStudioId: studioDataRow.anilistStudioId ?? null,
            })
            .returning();

          byNormalizedName.set(normalizedName, studioRow);
          if (studioRow.anilistStudioId != null) {
            byAnilistId.set(studioRow.anilistStudioId, studioRow);
          }
        } else {
          const nextName = studioRow.name || studioDataRow.name;
          const nextAnimationStudio =
            studioRow.isAnimationStudio || studioDataRow.isAnimationStudio;
          const nextAnilistStudioId =
            studioRow.anilistStudioId ?? studioDataRow.anilistStudioId ?? null;

          if (
            nextName !== studioRow.name ||
            nextAnimationStudio !== studioRow.isAnimationStudio ||
            nextAnilistStudioId !== studioRow.anilistStudioId
          ) {
            [studioRow] = await tx
              .update(studios)
              .set({
                name: nextName,
                isAnimationStudio: nextAnimationStudio,
                anilistStudioId: nextAnilistStudioId,
              })
              .where(eq(studios.id, studioRow.id))
              .returning();

            byNormalizedName.set(studioRow.normalizedName, studioRow);
            if (studioRow.anilistStudioId != null) {
              byAnilistId.set(studioRow.anilistStudioId, studioRow);
            }
          }
        }

        const existingLink = linkByStudioId.get(studioRow.id);
        linkByStudioId.set(studioRow.id, {
          animeId,
          studioId: studioRow.id,
          isMain: (existingLink?.isMain ?? false) || studioDataRow.isMain,
        });
      }

      const linkValues = [...linkByStudioId.values()];
      if (linkValues.length) {
        await tx.insert(animeStudioLinks).values(linkValues);
      }
    }
  }

  // Tags — replace on every sync
  if (data.tags !== undefined) {
    await tx.delete(animeTagLinks).where(eq(animeTagLinks.animeId, animeId));
    const tagData = dedupeProviderTags(data.tags);
    if (tagData.length) {
      const normalizedNames = tagData.map((tag) => normalizeEntityName(tag.name));
      const existingTags = await tx
        .select()
        .from(tags)
        .where(inArray(tags.normalizedName, normalizedNames));

      const byNormalizedName = new Map(
        existingTags.map((tag) => [tag.normalizedName, tag]),
      );
      const linkValues: Array<{ animeId: number; tagId: number; rank: number | null }> = [];

      for (const tagDataRow of tagData) {
        const normalizedName = normalizeEntityName(tagDataRow.name);
        let tagRow = byNormalizedName.get(normalizedName);

        if (!tagRow) {
          [tagRow] = await tx
            .insert(tags)
            .values({
              name: tagDataRow.name,
              normalizedName,
              category: tagDataRow.category ?? null,
              isGeneralSpoiler: tagDataRow.isGeneralSpoiler ?? false,
              isMediaSpoiler: tagDataRow.isMediaSpoiler ?? false,
              isAdult: tagDataRow.isAdult ?? false,
            })
            .returning();

          byNormalizedName.set(normalizedName, tagRow);
        } else {
          const nextName = tagRow.name || tagDataRow.name;
          const nextCategory = tagRow.category ?? tagDataRow.category ?? null;
          const nextGeneralSpoiler =
            tagRow.isGeneralSpoiler || (tagDataRow.isGeneralSpoiler ?? false);
          const nextMediaSpoiler =
            tagRow.isMediaSpoiler || (tagDataRow.isMediaSpoiler ?? false);
          const nextAdult = tagRow.isAdult || (tagDataRow.isAdult ?? false);

          if (
            nextName !== tagRow.name ||
            nextCategory !== tagRow.category ||
            nextGeneralSpoiler !== tagRow.isGeneralSpoiler ||
            nextMediaSpoiler !== tagRow.isMediaSpoiler ||
            nextAdult !== tagRow.isAdult
          ) {
            [tagRow] = await tx
              .update(tags)
              .set({
                name: nextName,
                category: nextCategory,
                isGeneralSpoiler: nextGeneralSpoiler,
                isMediaSpoiler: nextMediaSpoiler,
                isAdult: nextAdult,
              })
              .where(eq(tags.id, tagRow.id))
              .returning();

            byNormalizedName.set(normalizedName, tagRow);
          }
        }

        linkValues.push({
          animeId,
          tagId: tagRow.id,
          rank: tagDataRow.rank ?? null,
        });
      }

      if (linkValues.length) {
        await tx.insert(animeTagLinks).values(linkValues);
      }
    }
  }

  // External links — replace on every sync
  if (data.externalLinks !== undefined) {
    await tx
      .delete(animeExternalLinks)
      .where(eq(animeExternalLinks.animeId, animeId));
    if (data.externalLinks.length) {
      await tx.insert(animeExternalLinks).values(
        data.externalLinks.map((l) => ({
          animeId,
          site: l.site,
          url: l.url,
          type: l.type ?? null,
          language: l.language ?? null,
          color: l.color ?? null,
          icon: l.icon ?? null,
        })),
      );
    }
  }

  // Relations — additive; only insert when the related anime is already in the DB
  if (data.relations?.length) {
    const relIds = data.relations.map((r) => String(r.anilistId));
    const mappings = await tx
      .select({ animeId: animeMappings.animeId, providerId: animeMappings.providerId })
      .from(animeMappings)
      .where(and(eq(animeMappings.provider, "anilist"), inArray(animeMappings.providerId, relIds)));

    const animeIdByAnilist = new Map(mappings.map((m) => [m.providerId, m.animeId]));

    const values = data.relations
      .map((rel) => {
        const relatedAnimeId = animeIdByAnilist.get(String(rel.anilistId));
        if (!relatedAnimeId) return null;
        return { animeId, relatedAnimeId, relationType: rel.relationType };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    if (values.length) {
      await tx.insert(animeRelationLinks).values(values).onConflictDoNothing();
    }
  }
}

export async function upsertAnimeFromProvider(
  data: ProviderAnimeData,
): Promise<{ animeId: number; created: boolean }> {
  const existingMapping = await db
    .select({ animeId: animeMappings.animeId })
    .from(animeMappings)
    .where(
      and(
        eq(animeMappings.provider, data.provider),
        eq(animeMappings.providerId, data.providerId),
      ),
    )
    .limit(1);

  if (existingMapping[0]) {
    const { animeId } = existingMapping[0];

    await db.transaction(async (tx) => {
      await tx
        .update(anime)
        .set({
          ...buildAnimeFields(data),
          updatedAt: new Date(),
        })
        .where(eq(anime.id, animeId));

      await upsertRelatedData(animeId, data, tx);
    });

    return { animeId, created: false };
  }

  // Resolve slug before the transaction to avoid holding a lock during the lookup
  const slug = await resolveSlug(data.titleRomaji, data.providerId);

  const animeId = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(anime)
      .values({
        slug,
        ...buildAnimeFields(data),
      })
      .returning();

    if (!created) {
      throw new Error(
        `Failed to insert anime for ${data.provider}:${data.providerId}`,
      );
    }

    await tx.insert(animeMappings).values({
      animeId: created.id,
      provider: data.provider,
      providerId: data.providerId,
      providerSlug: data.providerSlug ?? null,
      providerUrl: data.providerUrl ?? null,
      confidence: 100,
      source: "api",
      isPrimary: true,
    });

    await upsertRelatedData(created.id, data, tx);

    return created.id;
  });

  return { animeId, created: true };
}
