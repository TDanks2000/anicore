import { Elysia, t } from "elysia";
import { notFound } from "../../lib/errors";
import {
  audioModeEnum,
  audioStatusEnum,
  confidenceValue,
  episodeKindEnum,
  episodeLanguageStatusEnum,
  idParams,
  languageCodeValue,
  languageMediaTypeEnum,
  nonNegativeInteger,
  paginationQuery,
  positiveInteger,
  providerEnum,
  providerIdValue,
  sourceEnum,
} from "../../lib/validators";
import { upsertLegacyEpisodeAudioStatus } from "../language-status/language-status.service";
import {
  createEpisode,
  getEpisode,
  getEpisodeAudio,
  getEpisodeFull,
  listEpisodes,
  listMappingsForEpisode,
} from "./episodes.service";

const optionalString = t.Optional(t.String());

const legacyAudioStatusBody = t.Object({
  audioMode: audioModeEnum,
  locale: t.Optional(languageCodeValue),
  status: t.Optional(audioStatusEnum),
  sourceProvider: optionalString,
});

export const episodeRoutes = new Elysia({ prefix: "/episodes", detail: { tags: ["Episodes"] } })
  .get("/", ({ query }) => listEpisodes(query), { query: t.Object(paginationQuery) })
  .post("/", ({ body }) => createEpisode(body), {
    body: t.Object({
      animeId: positiveInteger,
      number: positiveInteger,
      displayNumber: optionalString,
      sortNumber: t.Optional(t.Number()),
      seasonNumber: t.Optional(nonNegativeInteger),
      absoluteNumber: t.Optional(nonNegativeInteger),
      title: optionalString,
      titleRomaji: optionalString,
      titleEnglish: optionalString,
      titleNative: optionalString,
      synopsis: optionalString,
      airDate: optionalString,
      thumbnail: optionalString,
      lengthMinutes: t.Optional(nonNegativeInteger),
      kind: t.Optional(episodeKindEnum),
      mappings: t.Optional(
        t.Array(
          t.Object({
            provider: providerEnum,
            providerId: providerIdValue,
            providerSlug: optionalString,
            providerUrl: optionalString,
            providerEpisodeNumber: optionalString,
            confidence: t.Optional(confidenceValue),
            source: t.Optional(sourceEnum),
          }),
        ),
      ),
      audioStatuses: t.Optional(t.Array(legacyAudioStatusBody)),
      languageStatuses: t.Optional(
        t.Array(
          t.Object({
            languageCode: languageCodeValue,
            mediaType: languageMediaTypeEnum,
            status: t.Optional(episodeLanguageStatusEnum),
            provider: optionalString,
            confidence: t.Optional(confidenceValue),
          }),
        ),
      ),
    }),
  })
  .get("/:id", ({ params }) => getEpisode(params.id), { params: idParams })
  .get("/:id/full", ({ params }) => getEpisodeFull(params.id), { params: idParams })
  .get("/:id/mappings", ({ params }) => listMappingsForEpisode(params.id), { params: idParams })
  .get("/:id/audio", ({ params }) => getEpisodeAudio(params.id), { params: idParams })
  .post(
    "/:id/audio",
    async ({ params, body }) => {
      const status = await upsertLegacyEpisodeAudioStatus({ episodeId: params.id, ...body });
      if (!status) throw notFound("Episode not found");
      return status;
    },
    { params: idParams, body: legacyAudioStatusBody },
  );
