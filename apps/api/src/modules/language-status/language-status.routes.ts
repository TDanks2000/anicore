import { Elysia, t } from "elysia";

import {
  animeLanguageStatusEnum,
  confidenceValue,
  idParams,
  languageCodeValue,
  languageEvidenceSourceEnum,
  languageEvidenceTypeEnum,
  languageMediaTypeEnum,
  paginationQuery,
} from "../../lib/validators";
import { syncLanguageStatusForAnime } from "../../scripts/sync-audio-status";
import { assertAnimeExists } from "../anime/anime.service";
import {
  addAnimeLanguageEvidence,
  applyAnimeLanguageOverride,
  getResolvedAnimeLanguageStatus,
  listAnimeLanguageStatus,
  listLanguageStatusReviewQueue,
} from "./language-status.service";

const languageQuery = t.Object({ languageCode: t.Optional(languageCodeValue) });

export const languageStatusRoutes = new Elysia({ detail: { tags: ["Language status"] } })
  .get(
    "/anime/:id/language-status",
    async ({ params, query }) => {
      await assertAnimeExists(params.id);
      return listAnimeLanguageStatus(params.id, query);
    },
    {
      params: idParams,
      query: t.Object({
        languageCode: t.Optional(languageCodeValue),
        mediaType: t.Optional(languageMediaTypeEnum),
      }),
    },
  )
  .get(
    "/anime/:id/dub-status",
    async ({ params, query }) => {
      await assertAnimeExists(params.id);
      return getResolvedAnimeLanguageStatus({
        animeId: params.id,
        languageCode: query.languageCode ?? "en",
        mediaType: "audio",
      });
    },
    { params: idParams, query: languageQuery },
  )
  .get(
    "/anime/:id/subtitle-status",
    async ({ params, query }) => {
      await assertAnimeExists(params.id);
      return getResolvedAnimeLanguageStatus({
        animeId: params.id,
        languageCode: query.languageCode ?? "en",
        mediaType: "subtitle",
      });
    },
    { params: idParams, query: languageQuery },
  )
  .post(
    "/admin/anime/:id/language-refresh",
    async ({ params }) => {
      await assertAnimeExists(params.id);
      const refresh = await syncLanguageStatusForAnime(params.id);
      return { ...(await listAnimeLanguageStatus(params.id)), ...refresh };
    },
    { params: idParams },
  )
  .post(
    "/admin/anime/:id/language-evidence",
    async ({ params, body }) => {
      await assertAnimeExists(params.id);
      return addAnimeLanguageEvidence({ animeId: params.id, ...body });
    },
    {
      params: idParams,
      body: t.Object({
        languageCode: languageCodeValue,
        mediaType: languageMediaTypeEnum,
        source: languageEvidenceSourceEnum,
        sourceUrl: t.Optional(t.String()),
        evidenceType: languageEvidenceTypeEnum,
        value: t.String({ minLength: 1 }),
        confidence: t.Optional(confidenceValue),
      }),
    },
  )
  .post(
    "/admin/anime/:id/language-override",
    async ({ params, body }) => {
      await assertAnimeExists(params.id);
      return applyAnimeLanguageOverride({ animeId: params.id, ...body });
    },
    {
      params: idParams,
      body: t.Object({
        languageCode: languageCodeValue,
        mediaType: languageMediaTypeEnum,
        status: animeLanguageStatusEnum,
        confidence: t.Optional(confidenceValue),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .get("/admin/language-status/review-queue", ({ query }) => listLanguageStatusReviewQueue(query), {
    query: t.Object(paginationQuery),
  });
