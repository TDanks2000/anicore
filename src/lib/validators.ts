import { t } from "elysia";

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
