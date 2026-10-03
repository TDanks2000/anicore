import { db } from "@anicore/db";
import { replaceProviderLanguageSnapshot } from "@anicore/db/language-status";
import { animeLanguageEvidence, animeMappings } from "@anicore/db/schema";
import { and, eq } from "drizzle-orm";
import { fetchCharacters, type JikanCharacter } from "./client";

const LANGUAGE_CODES: Record<string, string> = {
  Japanese: "ja",
  English: "en",
  French: "fr",
  German: "de",
  Italian: "it",
  Spanish: "es",
  Portuguese: "pt",
  "Portuguese (BR)": "pt",
  "Portuguese (PT)": "pt",
  Korean: "ko",
  Chinese: "zh",
  Mandarin: "zh",
  Cantonese: "zh",
  Russian: "ru",
  Arabic: "ar",
  Hindi: "hi",
  Tamil: "ta",
  Telugu: "te",
  Thai: "th",
  Indonesian: "id",
  Malay: "ms",
  Vietnamese: "vi",
  Tagalog: "fil",
  Filipino: "fil",
  Turkish: "tr",
  Polish: "pl",
  Hungarian: "hu",
  Czech: "cs",
  Finnish: "fi",
  Swedish: "sv",
  Dutch: "nl",
  Danish: "da",
  Norwegian: "no",
  Hebrew: "he",
  Romanian: "ro",
  Greek: "el",
  Catalan: "ca",
  Ukrainian: "uk",
  Bengali: "bn",
};

export function voiceCastLanguages(
  characters: JikanCharacter[],
): Array<{ languageCode: string; confidence: number; characterCount: number }> {
  const byLanguage = new Map<string, Set<number>>();
  for (const row of characters) {
    for (const actor of row.voice_actors) {
      const languageCode = LANGUAGE_CODES[actor.language.trim()];
      if (!languageCode) continue;
      const ids = byLanguage.get(languageCode) ?? new Set<number>();
      ids.add(row.character.mal_id);
      byLanguage.set(languageCode, ids);
    }
  }
  // Cast credits establish probable language existence, never complete episode coverage.
  return [...byLanguage]
    .map(([languageCode, ids]) => ({ languageCode, confidence: 75, characterCount: ids.size }))
    .sort((a, b) => a.languageCode.localeCompare(b.languageCode));
}

export async function syncVoiceCastLanguages(
  animeId: number,
  fetchCast: typeof fetchCharacters = fetchCharacters,
): Promise<{ status: "matched" | "unmatched"; languages: string[] }> {
  const mappings = await db
    .select()
    .from(animeMappings)
    .where(and(eq(animeMappings.animeId, animeId), eq(animeMappings.provider, "mal")));
  const mapping = mappings[0];
  const snapshot = {
    animeId,
    provider: "jikan",
    sourceUrlPrefixes: ["https://api.jikan.moe/v4/anime/"],
    evidenceTypes: ["voice_cast" as const],
  };
  if (mappings.length > 1) {
    await replaceProviderLanguageSnapshot({ ...snapshot, evidence: [] });
    throw new Error(
      `Multiple MAL identities exist for anime ${animeId}; refusing to attach voice cast`,
    );
  }
  if (
    !mapping ||
    mapping.source === "fuzzy" ||
    mapping.confidence < 100 ||
    !/^[1-9]\d*$/.test(mapping.providerId)
  ) {
    await replaceProviderLanguageSnapshot({ ...snapshot, evidence: [] });
    return { status: "unmatched", languages: [] };
  }
  // A failed request preserves the last successful snapshot instead of fabricating absence.
  const sourceUrl = `https://api.jikan.moe/v4/anime/${mapping.providerId}/characters`;
  const oldEvidence = await db
    .select()
    .from(animeLanguageEvidence)
    .where(
      and(
        eq(animeLanguageEvidence.animeId, animeId),
        eq(animeLanguageEvidence.source, "provider"),
        eq(animeLanguageEvidence.evidenceType, "voice_cast"),
      ),
    );
  if (
    oldEvidence.some(
      (row) =>
        row.sourceUrl?.startsWith(snapshot.sourceUrlPrefixes[0]!) && row.sourceUrl !== sourceUrl,
    )
  )
    await replaceProviderLanguageSnapshot({ ...snapshot, evidence: [] });
  const characters = await fetchCast(mapping.providerId);
  if (characters === null) return { status: "unmatched", languages: [] };
  const languages = voiceCastLanguages(characters);
  await replaceProviderLanguageSnapshot({
    ...snapshot,
    evidence: languages.map((language) => ({
      languageCode: language.languageCode,
      mediaType: "audio" as const,
      evidenceType: "voice_cast" as const,
      sourceUrl: `https://api.jikan.moe/v4/anime/${mapping.providerId}/characters`,
      value: "available",
      confidence: language.confidence,
    })),
  });
  return { status: "matched", languages: languages.map((row) => row.languageCode) };
}
