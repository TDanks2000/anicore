import { t } from "elysia";

export const positiveInteger = t.Integer({ minimum: 1 });
export const nonNegativeInteger = t.Integer({ minimum: 0 });
export const confidenceValue = t.Integer({ minimum: 0, maximum: 100 });
export const languageCodeValue = t.String({
  minLength: 1,
  maxLength: 35,
  pattern: ".*\\S.*",
});

export const providerEnum = t.Union([
  t.Literal("anilist"),
  t.Literal("kitsu"),
  t.Literal("thetvdb"),
  t.Literal("mal"),
  t.Literal("tmdb"),
  t.Literal("simkl"),
  t.Literal("anisearch"),
  t.Literal("animeplanet"),
  t.Literal("animeschedule"),
  t.Literal("other"),
]);

export const sourceEnum = t.Union([
  t.Literal("manual"),
  t.Literal("api"),
  t.Literal("import"),
  t.Literal("fuzzy"),
  t.Literal("system"),
]);

export const episodeKindEnum = t.Union([
  t.Literal("normal"),
  t.Literal("special"),
  t.Literal("ova"),
  t.Literal("recap"),
  t.Literal("trailer"),
  t.Literal("extra"),
  t.Literal("other"),
]);

export const audioModeEnum = t.Union([t.Literal("original"), t.Literal("sub"), t.Literal("dub")]);

export const audioStatusEnum = t.Union([
  t.Literal("unknown"),
  t.Literal("unavailable"),
  t.Literal("available"),
  t.Literal("partial"),
]);

export const languageMediaTypeEnum = t.Union([
  t.Literal("audio"),
  t.Literal("subtitle"),
]);

export const animeLanguageStatusEnum = t.Union([
  t.Literal("unknown"),
  t.Literal("possible"),
  t.Literal("likely"),
  t.Literal("confirmed"),
  t.Literal("partial"),
  t.Literal("not_available"),
]);

export const episodeLanguageStatusEnum = t.Union([
  t.Literal("unknown"),
  t.Literal("available"),
  t.Literal("missing"),
  t.Literal("partial"),
]);

export const languageEvidenceSourceEnum = t.Union([
  t.Literal("ann"),
  t.Literal("official_site"),
  t.Literal("provider"),
  t.Literal("home_video"),
  t.Literal("community"),
  t.Literal("manual"),
  t.Literal("other"),
]);

export const languageEvidenceTypeEnum = t.Union([
  t.Literal("voice_cast"),
  t.Literal("provider_audio"),
  t.Literal("provider_subtitle"),
  t.Literal("official_announcement"),
  t.Literal("home_video_release"),
  t.Literal("manual_verified"),
  t.Literal("community_submission"),
  t.Literal("other"),
]);
