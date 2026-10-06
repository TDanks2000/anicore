import { db } from "@anicore/db";
import { replaceProviderLanguageSnapshot } from "@anicore/db/language-status";
import { animeLanguageEvidence, animeMappings } from "@anicore/db/schema";
import { and, eq } from "drizzle-orm";
import { withAnilistRetry } from "../../lib/anilist-rate-limit";
import { formatHttpError } from "../../lib/http";
import { waitForProvider } from "../../lib/provider-wait";
import { voiceCastLanguages } from "../jikan/sync";

export interface AnilistCastCharacter {
  role: string;
  node: { id: number };
  voiceActors: Array<{ id: number; name: { full: string }; languageV2: string | null }>;
}
const QUERY = `query($id:Int!,$page:Int!){Media(id:$id,type:ANIME){id characters(page:$page,perPage:50,role:MAIN,sort:ID){pageInfo{hasNextPage} edges{role node{id} voiceActors{id name{full} languageV2}}}}}`;
let queue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;
let nextRequestAt = 0;

export function validateAnilistCast(
  value: unknown,
  id: number,
): { characters: AnilistCastCharacter[]; hasNextPage: boolean } {
  const errors = (value as { errors?: Array<{ message?: string; status?: number }> } | null)
    ?.errors;
  if (Array.isArray(errors) && errors.length)
    throw new Error(
      `AniList voice cast: ${errors.map((error) => `${error.status ?? ""} ${error.message ?? "GraphQL error"}`).join(", ")}`,
    );
  const media = (
    value as {
      data?: {
        Media?: {
          id?: number;
          characters?: { edges?: AnilistCastCharacter[]; pageInfo?: { hasNextPage?: boolean } };
        };
      };
    } | null
  )?.data?.Media;
  if (
    media?.id !== id ||
    !Array.isArray(media.characters?.edges) ||
    typeof media.characters.pageInfo?.hasNextPage !== "boolean"
  )
    throw new Error("Invalid AniList cast identity or pagination");
  for (const character of media.characters.edges) {
    if (
      !character ||
      !Number.isInteger(character.node?.id) ||
      character.node.id <= 0 ||
      !Array.isArray(character.voiceActors)
    )
      throw new Error("Invalid AniList cast character");
    for (const actor of character.voiceActors)
      if (
        !actor ||
        !Number.isInteger(actor.id) ||
        actor.id <= 0 ||
        typeof actor.name?.full !== "string" ||
        (actor.languageV2 !== null && typeof actor.languageV2 !== "string")
      )
        throw new Error("Invalid AniList voice credit");
  }
  return { characters: media.characters.edges, hasNextPage: media.characters.pageInfo.hasNextPage };
}

async function requestCast(id: number, page: number) {
  const operation = queue.then(async () => {
    await waitForProvider(
      Math.max(0, 1100 - (Date.now() - lastRequestAt), nextRequestAt - Date.now()),
    );
    lastRequestAt = Date.now();
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { id, page } }),
      signal: AbortSignal.timeout(15000),
    });
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
    if (remaining !== null && Number(remaining) <= 2 && reset > Date.now())
      nextRequestAt = reset + 1000;
    if (!response.ok) throw new Error(await formatHttpError("AniList voice cast", response));
    return validateAnilistCast(await response.json(), id);
  });
  queue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export async function fetchAnilistCast(id: string): Promise<AnilistCastCharacter[]> {
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
    throw new Error("Invalid AniList cast ID");
  const characters: AnilistCastCharacter[] = [];
  for (let page = 1; page <= 20; page++) {
    const result = await withAnilistRetry(() => requestCast(Number(id), page));
    if (
      result.characters.some((character) =>
        characters.some((existing) => existing.node.id === character.node.id),
      )
    )
      throw new Error("Repeated AniList cast page");
    characters.push(...result.characters);
    if (!result.hasNextPage) return characters;
    if (!result.characters.length) throw new Error("Incomplete AniList cast page");
  }
  throw new Error("AniList cast pagination limit exceeded");
}

export async function syncAnilistCastLanguages(
  animeId: number,
  fetchCast: typeof fetchAnilistCast = fetchAnilistCast,
): Promise<{ status: "matched" | "unmatched"; languages: string[] }> {
  const mappings = await db
    .select()
    .from(animeMappings)
    .where(and(eq(animeMappings.animeId, animeId), eq(animeMappings.provider, "anilist")));
  const scope = {
    animeId,
    provider: "anilist-cast",
    sourceUrlPrefixes: ["https://anilist.co/anime/"],
    evidenceTypes: ["voice_cast" as const],
  };
  if (mappings.length !== 1) {
    await replaceProviderLanguageSnapshot({ ...scope, evidence: [] });
    throw new Error(`Expected one AniList identity for anime ${animeId}; found ${mappings.length}`);
  }
  const mapping = mappings[0]!;
  if (
    mapping.source === "fuzzy" ||
    mapping.confidence < 100 ||
    !/^[1-9]\d*$/.test(mapping.providerId) ||
    !Number.isSafeInteger(Number(mapping.providerId))
  ) {
    await replaceProviderLanguageSnapshot({ ...scope, evidence: [] });
    return { status: "unmatched", languages: [] };
  }
  const sourceUrl = `https://anilist.co/anime/${mapping.providerId}/characters`;
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
  // Evidence for a retired identity must not survive a failed lookup of its replacement.
  if (
    oldEvidence.some(
      (row) =>
        row.sourceUrl?.startsWith(scope.sourceUrlPrefixes[0]!) && row.sourceUrl !== sourceUrl,
    )
  )
    await replaceProviderLanguageSnapshot({ ...scope, evidence: [] });
  const characters = await fetchCast(mapping.providerId);
  const languages = voiceCastLanguages(
    characters.map((character) => ({
      character: { mal_id: character.node.id, name: "" },
      role: character.role,
      voice_actors: character.voiceActors
        .filter((actor) => actor.languageV2 !== null)
        .map((actor) => ({
          language: actor.languageV2!,
          person: { mal_id: actor.id, name: actor.name.full },
        })),
    })),
  );
  await replaceProviderLanguageSnapshot({
    ...scope,
    evidence: languages.map((language) => ({
      languageCode: language.languageCode,
      mediaType: "audio" as const,
      evidenceType: "voice_cast" as const,
      sourceUrl,
      value: "available",
      confidence: 75,
    })),
  });
  return { status: "matched", languages: languages.map((language) => language.languageCode) };
}
