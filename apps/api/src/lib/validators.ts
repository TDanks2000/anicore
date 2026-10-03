import {
  animeLanguageStatuses,
  episodeKinds,
  episodeLanguageStatuses,
  languageEvidenceSources,
  languageEvidenceTypes,
  languageMediaTypes,
  legacyAudioModes,
  legacyAudioStatuses,
  mappingSources,
  providers,
} from "@anicore/db/enums";
import { t } from "elysia";

export const positiveInteger = t.Integer({ minimum: 1 });
export const nonNegativeInteger = t.Integer({ minimum: 0 });
export const confidenceValue = t.Integer({ minimum: 0, maximum: 100 });
export const languageCodeValue = t.String({
  minLength: 1,
  maxLength: 35,
  pattern: ".*\\S.*",
});
export const providerIdValue = t.String({
  minLength: 1,
  maxLength: 512,
  pattern: ".*\\S.*",
});

export const providerEnum = t.UnionEnum(providers);
export const sourceEnum = t.UnionEnum(mappingSources);
export const episodeKindEnum = t.UnionEnum(episodeKinds);
export const audioModeEnum = t.UnionEnum(legacyAudioModes);
export const audioStatusEnum = t.UnionEnum(legacyAudioStatuses);
// UnionEnum supplies its first value as an implicit default, even inside Optional.
// Missing filters must stay absent and required evidence fields must be explicit.
export const languageMediaTypeEnum = t.Union(languageMediaTypes.map((value) => t.Literal(value)));
export const animeLanguageStatusEnum = t.Union(
  animeLanguageStatuses.map((value) => t.Literal(value)),
);
export const episodeLanguageStatusEnum = t.Union(
  episodeLanguageStatuses.map((value) => t.Literal(value)),
);
export const languageEvidenceSourceEnum = t.Union(
  languageEvidenceSources.map((value) => t.Literal(value)),
);
export const languageEvidenceTypeEnum = t.Union(
  languageEvidenceTypes.map((value) => t.Literal(value)),
);

export const MAX_PAGE_SIZE = 100;

/** `:id` path parameter, coerced to a positive integer. */
export const idParams = t.Object({ id: positiveInteger });

export const paginationQuery = {
  limit: t.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: 50 }),
  offset: t.Integer({ minimum: 0, default: 0 }),
};

export const providerMappingParams = t.Object({
  provider: providerEnum,
  providerId: providerIdValue,
});

/** Trims optional free text, treating blank strings as absent. */
export function optionalText(value: string | null | undefined): string | null {
  return value?.trim() || null;
}
