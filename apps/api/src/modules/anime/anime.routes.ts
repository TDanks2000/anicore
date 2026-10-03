import { Elysia, t } from "elysia";

import { notFound } from "../../lib/errors";
import {
  confidenceValue,
  idParams,
  nonNegativeInteger,
  paginationQuery,
  positiveInteger,
  providerEnum,
  providerIdValue,
  providerMappingParams,
  sourceEnum,
} from "../../lib/validators";
import { findAnimeByMapping, listAnimeMappings } from "../mappings/mappings.service";
import { importAnilistAnime, importAnilistAnimeBySearch } from "./anime.import";
import {
  animeSortFields,
  animeSortOrders,
  assertAnimeExists,
  createAnime,
  getAnime,
  getAnimeFull,
  getStudiosForAnime,
  getTagsForAnime,
  listAnime,
  listAnimeEpisodes,
  listAnimeExternalLinks,
  listAnimeRelations,
} from "./anime.service";

const optionalString = t.Optional(t.String());

// `t.UnionEnum` injects `default: values[0]`, which would make an omitted
// `sort` look like `sort=id` and silently drop search relevance ordering.
const optionalAnimeSort = t.Optional(t.Union(animeSortFields.map((field) => t.Literal(field))));
const optionalAnimeOrder = t.Optional(t.Union(animeSortOrders.map((order) => t.Literal(order))));

const createAnimeBody = t.Object({
  slug: optionalString,
  titleRomaji: t.String({ minLength: 1, pattern: ".*\\S.*" }),
  titleEnglish: optionalString,
  titleNative: optionalString,
  titleUserPreferred: optionalString,
  description: optionalString,
  format: optionalString,
  status: optionalString,
  source: optionalString,
  season: optionalString,
  seasonYear: t.Optional(nonNegativeInteger),
  startDate: optionalString,
  endDate: optionalString,
  episodeCount: t.Optional(nonNegativeInteger),
  durationMinutes: t.Optional(nonNegativeInteger),
  countryOfOrigin: optionalString,
  isAdult: t.Optional(t.Boolean()),
  genres: t.Optional(t.Array(t.String())),
  synonyms: t.Optional(t.Array(t.String())),
  averageScore: t.Optional(confidenceValue),
  meanScore: t.Optional(confidenceValue),
  popularity: t.Optional(nonNegativeInteger),
  favourites: t.Optional(nonNegativeInteger),
  trending: t.Optional(nonNegativeInteger),
  coverImage: optionalString,
  coverImageColor: optionalString,
  bannerImage: optionalString,
  trailerVideoId: optionalString,
  trailerSite: optionalString,
  trailerThumbnail: optionalString,
  nextEpisodeNumber: t.Optional(positiveInteger),
  nextEpisodeAirsAt: t.Optional(nonNegativeInteger),
  hashtag: optionalString,
  mappings: t.Optional(
    t.Array(
      t.Object({
        provider: providerEnum,
        providerId: providerIdValue,
        providerSlug: optionalString,
        providerUrl: optionalString,
        confidence: t.Optional(confidenceValue),
        source: t.Optional(sourceEnum),
        isPrimary: t.Optional(t.Boolean()),
      }),
    ),
  ),
});

export const animeRoutes = new Elysia({ prefix: "/anime", detail: { tags: ["Anime"] } })
  .get(
    "/",
    async ({ query, set }) => {
      const { items, total } = await listAnime(query);
      // The body stays a bare array for compatibility; the dashboard reads the
      // total from this header to render pagination.
      set.headers["X-Total-Count"] = String(total);
      return items;
    },
    {
      query: t.Object({
        ...paginationQuery,
        q: t.Optional(t.String({ maxLength: 200 })),
        format: optionalString,
        season: optionalString,
        seasonYear: t.Optional(nonNegativeInteger),
        status: optionalString,
        sort: optionalAnimeSort,
        order: optionalAnimeOrder,
      }),
    },
  )
  .post("/", ({ body }) => createAnime(body), { body: createAnimeBody })
  .post(
    "/import/anilist",
    // Must stay async: Elysia does not route a rejection from this non-async
    // arrow shape to onError, so an import failure would escape as a crash.
    async ({ body }) => {
      if ("id" in body) return importAnilistAnime(body.id);
      return importAnilistAnimeBySearch(body.search.trim());
    },
    {
      body: t.Union([
        t.Object({ id: positiveInteger }),
        t.Object({ search: t.String({ minLength: 1, maxLength: 200, pattern: ".*\\S.*" }) }),
      ]),
    },
  )
  .get(
    "/by/:provider/:providerId",
    async ({ params }) => {
      const found = await findAnimeByMapping(params);
      if (!found) throw notFound("Anime not found");
      return { ...found.anime, mapping: found.mapping };
    },
    { params: providerMappingParams },
  )
  .get("/:id", ({ params }) => getAnime(params.id), { params: idParams })
  .get("/:id/full", ({ params }) => getAnimeFull(params.id), { params: idParams })
  .get(
    "/:id/mappings",
    async ({ params }) => {
      await assertAnimeExists(params.id);
      return listAnimeMappings(params.id);
    },
    { params: idParams },
  )
  .get(
    "/:id/episodes",
    async ({ params }) => {
      await assertAnimeExists(params.id);
      return listAnimeEpisodes(params.id);
    },
    { params: idParams },
  )
  .get(
    "/:id/studios",
    async ({ params }) => {
      await assertAnimeExists(params.id);
      return getStudiosForAnime(params.id);
    },
    { params: idParams },
  )
  .get(
    "/:id/tags",
    async ({ params }) => {
      await assertAnimeExists(params.id);
      return getTagsForAnime(params.id);
    },
    { params: idParams },
  )
  .get(
    "/:id/external-links",
    async ({ params }) => {
      await assertAnimeExists(params.id);
      return listAnimeExternalLinks(params.id);
    },
    { params: idParams },
  )
  .get(
    "/:id/relations",
    async ({ params }) => {
      await assertAnimeExists(params.id);
      return listAnimeRelations(params.id);
    },
    { params: idParams },
  );
