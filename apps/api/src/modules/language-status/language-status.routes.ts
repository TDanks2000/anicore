import { Elysia, t } from "elysia";

import { parseId, parseLimit } from "../../lib/params";
import {
  animeLanguageStatusEnum,
  confidenceValue,
  languageCodeValue,
  languageEvidenceSourceEnum,
  languageEvidenceTypeEnum,
  languageMediaTypeEnum,
} from "../../lib/validators";
import {
  addAnimeLanguageEvidence,
  applyAnimeLanguageOverride,
  getAnimeById,
  getResolvedAnimeLanguageStatus,
  listAnimeLanguageStatus,
  listLanguageStatusReviewQueue,
} from "./language-status.service";

async function animeExists(animeId: number) {
  return Boolean(await getAnimeById(animeId));
}

export const languageStatusRoutes = new Elysia()
  .get(
    "/anime/:id/language-status",
    async ({ params, query, set }) => {
      const animeId = parseId(params.id);
      if (!animeId) {
        set.status = 400;
        return { error: "Invalid anime id" };
      }

      if (!(await animeExists(animeId))) {
        set.status = 404;
        return { error: "Anime not found" };
      }

      return listAnimeLanguageStatus(animeId, {
        languageCode: query.languageCode,
        mediaType: query.mediaType,
      });
    },
    {
      query: t.Object({
        languageCode: t.Optional(languageCodeValue),
        mediaType: t.Optional(languageMediaTypeEnum),
      }),
    },
  )

  .get(
    "/anime/:id/dub-status",
    async ({ params, query, set }) => {
      const animeId = parseId(params.id);
      if (!animeId) {
        set.status = 400;
        return { error: "Invalid anime id" };
      }

      if (!(await animeExists(animeId))) {
        set.status = 404;
        return { error: "Anime not found" };
      }

      return getResolvedAnimeLanguageStatus({
        animeId,
        languageCode: query.languageCode ?? "en",
        mediaType: "audio",
      });
    },
    {
      query: t.Object({
        languageCode: t.Optional(languageCodeValue),
      }),
    },
  )

  .get(
    "/anime/:id/subtitle-status",
    async ({ params, query, set }) => {
      const animeId = parseId(params.id);
      if (!animeId) {
        set.status = 400;
        return { error: "Invalid anime id" };
      }

      if (!(await animeExists(animeId))) {
        set.status = 404;
        return { error: "Anime not found" };
      }

      return getResolvedAnimeLanguageStatus({
        animeId,
        languageCode: query.languageCode ?? "en",
        mediaType: "subtitle",
      });
    },
    {
      query: t.Object({
        languageCode: t.Optional(languageCodeValue),
      }),
    },
  )

  .post(
    "/admin/anime/:animeId/language-evidence",
    async ({ params, body, set }) => {
      const animeId = parseId(params.animeId);
      if (!animeId) {
        set.status = 400;
        return { error: "Invalid anime id" };
      }

      if (!(await animeExists(animeId))) {
        set.status = 404;
        return { error: "Anime not found" };
      }

      return addAnimeLanguageEvidence({
        animeId,
        languageCode: body.languageCode,
        mediaType: body.mediaType,
        source: body.source,
        sourceUrl: body.sourceUrl,
        evidenceType: body.evidenceType,
        value: body.value,
        confidence: body.confidence,
      });
    },
    {
      body: t.Object({
        languageCode: languageCodeValue,
        mediaType: languageMediaTypeEnum,
        source: languageEvidenceSourceEnum,
        sourceUrl: t.Optional(t.String()),
        evidenceType: languageEvidenceTypeEnum,
        value: t.String(),
        confidence: t.Optional(confidenceValue),
      }),
    },
  )

  .post(
    "/admin/anime/:animeId/language-override",
    async ({ params, body, set }) => {
      const animeId = parseId(params.animeId);
      if (!animeId) {
        set.status = 400;
        return { error: "Invalid anime id" };
      }

      if (!(await animeExists(animeId))) {
        set.status = 404;
        return { error: "Anime not found" };
      }

      return applyAnimeLanguageOverride({
        animeId,
        languageCode: body.languageCode,
        mediaType: body.mediaType,
        status: body.status,
        confidence: body.confidence,
        notes: body.notes,
      });
    },
    {
      body: t.Object({
        languageCode: languageCodeValue,
        mediaType: languageMediaTypeEnum,
        status: animeLanguageStatusEnum,
        confidence: t.Optional(confidenceValue),
        notes: t.Optional(t.String()),
      }),
    },
  )

  .get(
    "/admin/language-status/review-queue",
    ({ query }) => {
      return listLanguageStatusReviewQueue(parseLimit(query.limit));
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
      }),
    },
  );
