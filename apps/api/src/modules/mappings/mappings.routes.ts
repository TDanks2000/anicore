import { Elysia, t } from "elysia";

import { notFound } from "../../lib/errors";
import {
  confidenceValue,
  positiveInteger,
  providerEnum,
  providerIdValue,
  providerMappingParams,
  sourceEnum,
} from "../../lib/validators";
import {
  createAnimeMapping,
  createEpisodeMapping,
  deleteAnimeMapping,
  deleteEpisodeMapping,
  findAnimeByMapping,
  findEpisodeByMapping,
  updateAnimeMapping,
  updateEpisodeMapping,
} from "./mappings.service";

const optionalString = t.Optional(t.String());

export const mappingRoutes = new Elysia({ prefix: "/mappings", detail: { tags: ["Mappings"] } })
  .get(
    "/anime/:provider/:providerId",
    async ({ params }) => {
      const found = await findAnimeByMapping(params);
      if (!found) throw notFound("Anime mapping not found");
      return found;
    },
    { params: providerMappingParams },
  )
  .post("/anime", ({ body }) => createAnimeMapping(body), {
    body: t.Object({
      animeId: positiveInteger,
      provider: providerEnum,
      providerId: providerIdValue,
      providerSlug: optionalString,
      providerUrl: optionalString,
      confidence: t.Optional(confidenceValue),
      source: t.Optional(sourceEnum),
      isPrimary: t.Optional(t.Boolean()),
    }),
  })
  .patch("/anime/:provider/:providerId", ({ params, body }) => updateAnimeMapping(params, body), {
    params: providerMappingParams,
    body: t.Object({
      providerSlug: optionalString,
      providerUrl: optionalString,
      confidence: t.Optional(confidenceValue),
      source: t.Optional(sourceEnum),
      isPrimary: t.Optional(t.Boolean()),
    }),
  })
  .delete("/anime/:provider/:providerId", ({ params }) => deleteAnimeMapping(params), {
    params: providerMappingParams,
  })
  .get(
    "/episode/:provider/:providerId",
    async ({ params }) => {
      const found = await findEpisodeByMapping(params);
      if (!found) throw notFound("Episode mapping not found");
      return found;
    },
    { params: providerMappingParams },
  )
  .post("/episode", ({ body }) => createEpisodeMapping(body), {
    body: t.Object({
      episodeId: positiveInteger,
      provider: providerEnum,
      providerId: providerIdValue,
      providerSlug: optionalString,
      providerUrl: optionalString,
      providerEpisodeNumber: optionalString,
      confidence: t.Optional(confidenceValue),
      source: t.Optional(sourceEnum),
    }),
  })
  .patch(
    "/episode/:provider/:providerId",
    ({ params, body }) => updateEpisodeMapping(params, body),
    {
      params: providerMappingParams,
      body: t.Object({
        providerSlug: optionalString,
        providerUrl: optionalString,
        providerEpisodeNumber: optionalString,
        confidence: t.Optional(confidenceValue),
        source: t.Optional(sourceEnum),
      }),
    },
  )
  .delete("/episode/:provider/:providerId", ({ params }) => deleteEpisodeMapping(params), {
    params: providerMappingParams,
  });
