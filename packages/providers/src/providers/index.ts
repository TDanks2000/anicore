import { db } from "@anicore/db";
import { isUniqueViolation } from "@anicore/db/errors";
import {
  anime,
  animeExternalLinks,
  animeMappings,
  animeRelationLinks,
  animeStudioLinks,
  animeTagLinks,
  type NewAnime,
  studios,
  tags,
} from "@anicore/db/schema";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { toJsonArray } from "../lib/json";
import { slugCandidates } from "../lib/slug";
import { syncAuthoritativeCrossMappings } from "./authoritative-cross-mappings";
import { dedupeProviderStudios, dedupeProviderTags, normalizeEntityName } from "./normalize";
import type { ProviderAnimeData, ProviderStudio, ProviderTag } from "./types";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Inserts an anime row under the first free slug from `candidates`.
 *
 * Each attempt uses ON CONFLICT DO NOTHING on the slug, so a taken slug never
 * aborts the surrounding transaction and two writers racing for the same
 * title both succeed with different slugs.
 */
export async function insertAnimeWithUniqueSlug(
  tx: Tx,
  values: Omit<NewAnime, "slug">,
  candidates: Iterable<string>,
  maxAttempts = 50,
) {
  let attempts = 0;
  for (const slug of candidates) {
    if (++attempts > maxAttempts) break;
    const [row] = await tx
      .insert(anime)
      .values({ ...values, slug })
      .onConflictDoNothing({ target: anime.slug })
      .returning();
    if (row) return row;
  }
  throw new Error(`No free slug for "${values.titleRomaji}" after ${maxAttempts} attempts`);
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

type StudioRow = typeof studios.$inferSelect;
type TagRow = typeof tags.$inferSelect;

/** Compare persisted fields only; provider order and row IDs do not affect equality. */
function sameCollection(
  existing: readonly object[],
  desired: readonly object[],
  fields: string[],
): boolean {
  if (existing.length !== desired.length) return false;
  const signatures = (rows: readonly object[]) =>
    rows.map((row) => JSON.stringify(fields.map((field) => Reflect.get(row, field)))).sort();
  const left = signatures(existing);
  const right = signatures(desired);
  return left.every((value, index) => value === right[index]);
}

/**
 * Links an anime to its studios, creating any studio not seen before.
 *
 * Missing studios are inserted with ON CONFLICT DO NOTHING and then read back,
 * so a concurrent writer creating the same studio cannot fail this sync.
 */
async function replaceStudioLinks(tx: Tx, animeId: number, provided: ProviderStudio[]) {
  const studioData = dedupeProviderStudios(provided);
  if (studioData.length === 0) {
    await tx.delete(animeStudioLinks).where(eq(animeStudioLinks.animeId, animeId));
    return;
  }

  const names = studioData.map((studio) => normalizeEntityName(studio.name));
  const anilistIds = studioData
    .map((studio) => studio.anilistStudioId)
    .filter((id): id is number => id != null);

  const rows = await tx
    .select()
    .from(studios)
    .where(
      or(
        inArray(studios.normalizedName, names),
        anilistIds.length ? inArray(studios.anilistStudioId, anilistIds) : sql`false`,
      ),
    );
  const byName = new Map(rows.map((row) => [row.normalizedName, row]));
  const byAnilistId = new Map(
    rows.filter((row) => row.anilistStudioId !== null).map((row) => [row.anilistStudioId!, row]),
  );

  const missing = studioData.filter(
    (studio) =>
      !byName.has(normalizeEntityName(studio.name)) &&
      (studio.anilistStudioId == null || !byAnilistId.has(studio.anilistStudioId)),
  );
  if (missing.length) {
    const inserted = await tx
      .insert(studios)
      .values(
        missing.map((studio) => ({
          name: studio.name,
          normalizedName: normalizeEntityName(studio.name),
          isAnimationStudio: studio.isAnimationStudio,
          anilistStudioId: studio.anilistStudioId ?? null,
        })),
      )
      .onConflictDoNothing()
      .returning();
    for (const row of inserted) {
      byName.set(row.normalizedName, row);
      if (row.anilistStudioId !== null) byAnilistId.set(row.anilistStudioId, row);
    }
  }

  const links = new Map<number, { animeId: number; studioId: number; isMain: boolean }>();
  for (const studio of studioData) {
    let row: StudioRow | undefined =
      (studio.anilistStudioId != null ? byAnilistId.get(studio.anilistStudioId) : undefined) ??
      byName.get(normalizeEntityName(studio.name));
    if (!row) throw new Error(`Studio "${studio.name}" was neither inserted nor found`);

    // Fill in what an older row lacks without discarding what it already has.
    const merged = {
      isAnimationStudio: row.isAnimationStudio || studio.isAnimationStudio,
      anilistStudioId: row.anilistStudioId ?? studio.anilistStudioId ?? null,
    };
    if (
      merged.isAnimationStudio !== row.isAnimationStudio ||
      merged.anilistStudioId !== row.anilistStudioId
    ) {
      [row] = await tx.update(studios).set(merged).where(eq(studios.id, row.id)).returning();
    }

    links.set(row!.id, {
      animeId,
      studioId: row!.id,
      isMain: (links.get(row!.id)?.isMain ?? false) || studio.isMain,
    });
  }

  const desired = [...links.values()];
  const existing = await tx
    .select()
    .from(animeStudioLinks)
    .where(eq(animeStudioLinks.animeId, animeId));
  if (!sameCollection(existing, desired, ["studioId", "isMain"])) {
    await tx.delete(animeStudioLinks).where(eq(animeStudioLinks.animeId, animeId));
    await tx.insert(animeStudioLinks).values(desired);
  }
}

/** Links an anime to its tags, creating any tag not seen before (race-safe). */
async function replaceTagLinks(tx: Tx, animeId: number, provided: ProviderTag[]) {
  const tagData = dedupeProviderTags(provided);
  if (tagData.length === 0) {
    await tx.delete(animeTagLinks).where(eq(animeTagLinks.animeId, animeId));
    return;
  }

  const rows = await tx
    .select()
    .from(tags)
    .where(
      inArray(
        tags.normalizedName,
        tagData.map((tag) => normalizeEntityName(tag.name)),
      ),
    );
  const byName = new Map(rows.map((row) => [row.normalizedName, row]));
  const missing = tagData.filter((tag) => !byName.has(normalizeEntityName(tag.name)));
  if (missing.length) {
    const inserted = await tx
      .insert(tags)
      .values(
        missing.map((tag) => ({
          name: tag.name,
          normalizedName: normalizeEntityName(tag.name),
          category: tag.category ?? null,
          isGeneralSpoiler: tag.isGeneralSpoiler ?? false,
          isMediaSpoiler: tag.isMediaSpoiler ?? false,
          isAdult: tag.isAdult ?? false,
        })),
      )
      .onConflictDoNothing()
      .returning();
    for (const row of inserted) byName.set(row.normalizedName, row);
  }

  const links: Array<{ animeId: number; tagId: number; rank: number | null }> = [];
  for (const tag of tagData) {
    const row: TagRow | undefined = byName.get(normalizeEntityName(tag.name));
    if (!row) throw new Error(`Tag "${tag.name}" was neither inserted nor found`);

    const merged = {
      category: row.category ?? tag.category ?? null,
      isGeneralSpoiler: row.isGeneralSpoiler || (tag.isGeneralSpoiler ?? false),
      isMediaSpoiler: row.isMediaSpoiler || (tag.isMediaSpoiler ?? false),
      isAdult: row.isAdult || (tag.isAdult ?? false),
    };
    if (
      merged.category !== row.category ||
      merged.isGeneralSpoiler !== row.isGeneralSpoiler ||
      merged.isMediaSpoiler !== row.isMediaSpoiler ||
      merged.isAdult !== row.isAdult
    ) {
      await tx.update(tags).set(merged).where(eq(tags.id, row.id));
    }

    links.push({ animeId, tagId: row.id, rank: tag.rank ?? null });
  }

  const existing = await tx.select().from(animeTagLinks).where(eq(animeTagLinks.animeId, animeId));
  if (!sameCollection(existing, links, ["tagId", "rank"])) {
    await tx.delete(animeTagLinks).where(eq(animeTagLinks.animeId, animeId));
    await tx.insert(animeTagLinks).values(links);
  }
}

async function upsertRelatedData(animeId: number, data: ProviderAnimeData, tx: Tx): Promise<void> {
  // Collections are authoritative, but unchanged associations retain their rows.
  if (data.studios !== undefined) await replaceStudioLinks(tx, animeId, data.studios);
  if (data.tags !== undefined) await replaceTagLinks(tx, animeId, data.tags);

  if (data.externalLinks !== undefined) {
    // Providers occasionally list one URL twice; keep the first.
    const byUrl = new Map<string, typeof animeExternalLinks.$inferInsert>();
    for (const link of data.externalLinks) {
      if (!byUrl.has(link.url))
        byUrl.set(link.url, {
          animeId,
          site: link.site,
          url: link.url,
          type: link.type ?? null,
          language: link.language ?? null,
          color: link.color ?? null,
          icon: link.icon ?? null,
        });
    }
    const desired = [...byUrl.values()];
    const existing = await tx
      .select()
      .from(animeExternalLinks)
      .where(eq(animeExternalLinks.animeId, animeId));
    if (!sameCollection(existing, desired, ["site", "url", "type", "language", "color", "icon"])) {
      await tx.delete(animeExternalLinks).where(eq(animeExternalLinks.animeId, animeId));
      if (desired.length) await tx.insert(animeExternalLinks).values(desired);
    }
  }

  // Relations are additive, and only link anime already in the database; the
  // other side links back when it is synced.
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

async function syncCrossMappingsIfPresent(animeId: number, data: ProviderAnimeData): Promise<void> {
  if (data.authoritativeMappings?.length) {
    await syncAuthoritativeCrossMappings(animeId, data.authoritativeMappings);
  }
}

async function findMappedAnimeId(data: ProviderAnimeData): Promise<number | null> {
  const [row] = await db
    .select({ animeId: animeMappings.animeId })
    .from(animeMappings)
    .where(
      and(eq(animeMappings.provider, data.provider), eq(animeMappings.providerId, data.providerId)),
    )
    .limit(1);
  return row?.animeId ?? null;
}

async function updateMappedAnime(animeId: number, data: ProviderAnimeData): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(anime)
      .set({ ...buildAnimeFields(data), updatedAt: new Date() })
      .where(eq(anime.id, animeId));
    await upsertRelatedData(animeId, data, tx);
  });
}

async function insertMappedAnime(data: ProviderAnimeData): Promise<number> {
  return db.transaction(async (tx) => {
    const created = await insertAnimeWithUniqueSlug(
      tx,
      buildAnimeFields(data),
      slugCandidates(data.titleRomaji, data.providerId),
    );

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
}

/**
 * Creates or refreshes the anime a provider record maps to.
 *
 * The API import and the sync process can both write the same new record. If
 * another writer creates it between our lookup and insert, the mapping insert
 * fails its unique index, the transaction rolls back, and the retry takes the
 * update path instead.
 */
export async function upsertAnimeFromProvider(
  data: ProviderAnimeData,
): Promise<{ animeId: number; created: boolean }> {
  for (let attempt = 0; ; attempt++) {
    const existingId = await findMappedAnimeId(data);
    if (existingId !== null) {
      await updateMappedAnime(existingId, data);
      await syncCrossMappingsIfPresent(existingId, data);
      return { animeId: existingId, created: false };
    }

    try {
      const animeId = await insertMappedAnime(data);
      await syncCrossMappingsIfPresent(animeId, data);
      return { animeId, created: true };
    } catch (error) {
      if (attempt === 0 && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}
