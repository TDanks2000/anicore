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
export const languageMediaTypeEnum = t.UnionEnum(languageMediaTypes);
export const animeLanguageStatusEnum = t.UnionEnum(animeLanguageStatuses);
export const episodeLanguageStatusEnum = t.UnionEnum(episodeLanguageStatuses);
export const languageEvidenceSourceEnum = t.UnionEnum(languageEvidenceSources);
export const languageEvidenceTypeEnum = t.UnionEnum(languageEvidenceTypes);
