import { db, readDb } from "@anicore/db";
import {
  anime,
  animeExternalLinks,
  animeRelationLinks,
  animeStudioLinks,
  animeTagLinks,
  episodes,
  studios,
  tags,
} from "@anicore/db/schema";
import { insertAnimeWithUniqueSlug } from "@anicore/providers";
import { fromJsonArray, toJsonArray } from "@anicore/providers/lib/json";
import { slugCandidates } from "@anicore/providers/lib/slug";
import {
  type AnyColumn,
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { badRequest, conflict, notFound } from "../../lib/errors";
import { optionalText } from "../../lib/validators";
import {
  type AnimeMappingInput,
  insertAnimeMappings,
  listAnimeMappings,
  listAnimeSegmentMappings,
  prepareNewAnimeMappings,
} from "../mappings/mappings.service";
import { listAnimeSeasonMappings } from "../mappings/season-mappings.service";
import { formatAnime } from "./anime.format";

/** Fields the public anime list can be ordered by. */
export const animeSortFields = [
  "id",
  "title",
  "format",
  "status",
  "seasonYear",
  "episodes",
  "score",
  "popularity",
] as const;
export type AnimeSortField = (typeof animeSortFields)[number];

export const animeSortOrders = ["asc", "desc"] as const;
export type AnimeSortOrder = (typeof animeSortOrders)[number];

export interface AnimeListQuery {
  limit: number;
  offset: number;
  q?: string;
  format?: string;
  season?: string;
  seasonYear?: number;
  status?: string;
  sort?: AnimeSortField;
  order?: AnimeSortOrder;
  projection?: "full" | "summary";
  pagination?: "offset" | "cursor";
  afterId?: number;
}

/** Escapes LIKE metacharacters so user input only ever matches literally. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Case-insensitive match against an {@link escapeLikePattern} pattern. SQLite's
 * LIKE ignores ASCII case but has no default escape character, so it is set
 * explicitly.
 */
function likeEscaped(column: AnyColumn, pattern: string): SQL {
  return sql`${column} like ${pattern} escape '\\'`;
}

function searchConditions(search: string): { where: SQL; rank: SQL } {
  const contains = `%${escapeLikePattern(search)}%`;
  const prefix = `${escapeLikePattern(search)}%`;
  const exact = search.toLowerCase();

  const literal = or(
    likeEscaped(anime.titleRomaji, contains),
    likeEscaped(anime.titleEnglish, contains),
    likeEscaped(anime.titleNative, contains),
    likeEscaped(anime.titleUserPreferred, contains),
    likeEscaped(anime.synonymsJson, contains),
    likeEscaped(anime.slug, contains),
  )!;

  // Trigrams only narrow candidates; the original LIKE conditions remain the
  // source of truth for ASCII case, JSON synonyms, escapes and exact results.
  // FTS needs >=3 Unicode characters. NUL has special LIKE termination semantics.
  const useIndex = !search.includes("\0") && Array.from(search).length >= 3;
  const phrase = `"${search.replaceAll('"', '""')}"`;
  const where = useIndex
    ? and(
        sql`${anime.id} in (select rowid from anime_search where anime_search match ${phrase})`,
        literal,
      )!
    : literal;

  // Exact title matches first, then prefix matches, then everything else.
  const rank = sql`case
    when lower(${anime.titleRomaji}) = ${exact} or lower(${anime.titleEnglish}) = ${exact} then 0
    when ${likeEscaped(anime.titleRomaji, prefix)} or ${likeEscaped(anime.titleEnglish, prefix)} then 1
    else 2
  end`;

  return { where, rank };
}

const animeSortColumns: Record<AnimeSortField, AnyColumn | SQL> = {
  id: anime.id,
  title: sql`lower(${anime.titleRomaji})`,
  format: anime.format,
  status: anime.status,
  seasonYear: anime.seasonYear,
  episodes: anime.episodeCount,
  score: anime.averageScore,
  popularity: anime.popularity,
};

/** Fields that can be absent; missing values sort after real ones either way. */
const nullableSortFields: ReadonlySet<AnimeSortField> = new Set([
  "format",
  "status",
  "seasonYear",
  "episodes",
  "score",
  "popularity",
]);

function listOrder(query: AnimeListQuery, ranked: { rank: SQL } | null): SQL[] {
  if (!query.sort) {
    // Without an explicit sort, search results stay relevance-ranked and plain
    // lists stay in id order, matching the original contract.
    return ranked
      ? [ranked.rank, sql`${anime.popularity} desc nulls last`, asc(anime.id)]
      : [asc(anime.id)];
  }

  const column = animeSortColumns[query.sort];
  const primary = query.order === "desc" ? desc(column) : asc(column);
  const ordered = nullableSortFields.has(query.sort) ? sql`${primary} nulls last` : primary;
  // Ids are unique, so they keep pagination stable when the sorted values tie.
  return query.sort === "id" ? [ordered] : [ordered, asc(anime.id)];
}

export async function listAnime(query: AnimeListQuery) {
  const conditions: SQL[] = [];
  const search = query.q?.trim();
  const ranked = search ? searchConditions(search) : null;

  if (ranked) conditions.push(ranked.where);
  if (query.format) conditions.push(eq(anime.format, query.format.toUpperCase()));
  if (query.season) conditions.push(eq(anime.season, query.season.toUpperCase()));
  if (query.status) conditions.push(eq(anime.status, query.status.toUpperCase()));
  if (query.seasonYear !== undefined) conditions.push(eq(anime.seasonYear, query.seasonYear));

  const where = conditions.length ? and(...conditions) : undefined;
  if (query.afterId !== undefined && query.pagination !== "cursor")
    throw badRequest("afterId requires cursor pagination");
  if (query.pagination === "cursor" && (query.offset !== 0 || (query.sort && query.sort !== "id")))
    throw badRequest("Cursor pagination requires offset=0 and id sorting");
  if (query.pagination === "cursor" && ranked && !query.sort)
    throw badRequest("Search cursor pagination requires sort=id");
  const pageWhere =
    query.pagination === "cursor" && query.afterId !== undefined
      ? and(
          where,
          query.order === "desc" ? lt(anime.id, query.afterId) : gt(anime.id, query.afterId),
        )
      : where;
  const order = listOrder(query, ranked);
  const columns = getTableColumns(anime);
  const {
    description,
    bannerImage,
    trailerVideoId,
    trailerSite,
    trailerThumbnail,
    hashtag,
    ...summary
  } = columns;
  const selection = query.projection === "summary" ? summary : columns;
  const limit = query.limit + (query.pagination === "cursor" ? 1 : 0);
  // Large offsets first select a small page of IDs from covering indexes,
  // then hydrate those rows. Both steps remain one SQL statement/snapshot.
  const pageIds = readDb
    .select({ id: anime.id })
    .from(anime)
    .where(pageWhere)
    .orderBy(...order)
    .limit(query.limit)
    .offset(query.offset);
  const page =
    query.offset >= 1000
      ? readDb
          .select(selection)
          .from(anime)
          .where(inArray(anime.id, pageIds))
          .orderBy(...order)
      : readDb
          .select(selection)
          .from(anime)
          .where(pageWhere)
          .orderBy(...order)
          .limit(limit)
          .offset(query.offset);

  const [rows, countRows] = await Promise.all([
    page,
    readDb.select({ total: sql<number>`count(*)` }).from(anime).where(where),
  ]);

  const hasNext = query.pagination === "cursor" && rows.length > query.limit;
  const visible = rows.slice(0, query.limit);
  return {
    items: visible.map((row) => {
      const { genresJson, synonymsJson, ...rest } = row;
      return { ...rest, genres: fromJsonArray(genresJson), synonyms: fromJsonArray(synonymsJson) };
    }),
    total: countRows[0]?.total ?? 0,
    nextCursor: hasNext ? visible.at(-1)!.id : null,
  };
}

async function findAnimeRow(id: number) {
  const [row] = await readDb.select().from(anime).where(eq(anime.id, id)).limit(1);
  return row ?? null;
}

export async function getAnime(id: number) {
  const row = await findAnimeRow(id);
  if (!row) throw notFound("Anime not found");
  return formatAnime(row);
}

export async function assertAnimeExists(id: number): Promise<void> {
  const [row] = await readDb.select({ id: anime.id }).from(anime).where(eq(anime.id, id)).limit(1);
  if (!row) throw notFound("Anime not found");
}

export function listAnimeEpisodes(animeId: number) {
  return readDb
    .select()
    .from(episodes)
    .where(eq(episodes.animeId, animeId))
    .orderBy(asc(episodes.sortNumber), asc(episodes.number), asc(episodes.id));
}

export function getStudiosForAnime(animeId: number) {
  return readDb
    .select({
      id: studios.id,
      name: studios.name,
      isMain: animeStudioLinks.isMain,
      isAnimationStudio: studios.isAnimationStudio,
      anilistStudioId: studios.anilistStudioId,
    })
    .from(animeStudioLinks)
    .innerJoin(studios, eq(animeStudioLinks.studioId, studios.id))
    .where(eq(animeStudioLinks.animeId, animeId))
    .orderBy(desc(animeStudioLinks.isMain), asc(studios.name));
}

export function getTagsForAnime(animeId: number) {
  return readDb
    .select({
      id: tags.id,
      name: tags.name,
      category: tags.category,
      rank: animeTagLinks.rank,
      isGeneralSpoiler: tags.isGeneralSpoiler,
      isMediaSpoiler: tags.isMediaSpoiler,
      isAdult: tags.isAdult,
    })
    .from(animeTagLinks)
    .innerJoin(tags, eq(animeTagLinks.tagId, tags.id))
    .where(eq(animeTagLinks.animeId, animeId))
    .orderBy(sql`${animeTagLinks.rank} desc nulls last`, asc(tags.name));
}

export function listAnimeExternalLinks(animeId: number) {
  return readDb
    .select()
    .from(animeExternalLinks)
    .where(eq(animeExternalLinks.animeId, animeId))
    .orderBy(asc(animeExternalLinks.site), asc(animeExternalLinks.id));
}

export function listAnimeRelations(animeId: number) {
  return readDb
    .select()
    .from(animeRelationLinks)
    .where(eq(animeRelationLinks.animeId, animeId))
    .orderBy(asc(animeRelationLinks.relationType), asc(animeRelationLinks.relatedAnimeId));
}

export async function getAnimeFull(id: number) {
  const row = await findAnimeRow(id);
  if (!row) throw notFound("Anime not found");

  const [
    mappings,
    segmentMappings,
    episodeRows,
    studioRows,
    tagRows,
    externalLinks,
    relations,
    seasonMappingRows,
  ] = await Promise.all([
    listAnimeMappings(id),
    listAnimeSegmentMappings(id),
    listAnimeEpisodes(id),
    getStudiosForAnime(id),
    getTagsForAnime(id),
    listAnimeExternalLinks(id),
    listAnimeRelations(id),
    listAnimeSeasonMappings(id),
  ]);

  return {
    ...formatAnime(row),
    mappings,
    segmentMappings,
    seasonMappings: seasonMappingRows,
    episodes: episodeRows,
    studios: studioRows,
    tags: tagRows,
    externalLinks,
    relations,
  };
}

export interface CreateAnimeInput {
  slug?: string;
  titleRomaji: string;
  titleEnglish?: string;
  titleNative?: string;
  titleUserPreferred?: string;
  description?: string;
  format?: string;
  status?: string;
  source?: string;
  season?: string;
  seasonYear?: number;
  startDate?: string;
  endDate?: string;
  episodeCount?: number;
  durationMinutes?: number;
  countryOfOrigin?: string;
  isAdult?: boolean;
  genres?: string[];
  synonyms?: string[];
  averageScore?: number;
  meanScore?: number;
  popularity?: number;
  favourites?: number;
  trending?: number;
  coverImage?: string;
  coverImageColor?: string;
  bannerImage?: string;
  trailerVideoId?: string;
  trailerSite?: string;
  trailerThumbnail?: string;
  nextEpisodeNumber?: number;
  nextEpisodeAirsAt?: number;
  hashtag?: string;
  mappings?: AnimeMappingInput[];
}

export async function createAnime(input: CreateAnimeInput) {
  const { mappings = [], genres, synonyms, slug, ...fields } = input;
  const preparedMappings = prepareNewAnimeMappings(mappings);

  return db.transaction(async (tx) => {
    const values = {
      ...fields,
      isAdult: fields.isAdult ?? false,
      genresJson: toJsonArray(genres),
      synonymsJson: toJsonArray(synonyms),
    };
    const requestedSlug = optionalText(slug);

    let row: typeof anime.$inferSelect | undefined;
    if (requestedSlug) {
      [row] = await tx
        .insert(anime)
        .values({ ...values, slug: requestedSlug })
        .onConflictDoNothing({ target: anime.slug })
        .returning();
      if (!row) throw conflict("An anime with this slug already exists");
    } else {
      row = await insertAnimeWithUniqueSlug(tx, values, slugCandidates(fields.titleRomaji));
    }

    await insertAnimeMappings(tx, row!.id, preparedMappings);
    return formatAnime(row!);
  });
}
