import { anilistClient } from "@anicore/providers/anilist/client";
import { syncAnilistAnime } from "@anicore/providers/anilist/sync";
import { withAnilistRetry } from "@anicore/providers/lib/anilist-rate-limit";
import { appendAnilistId } from "@anicore/providers/lib/cache";

import { HttpError, notFound } from "../../lib/errors";
import type { AnimeResponse } from "./anime.format";
import { getAnime } from "./anime.service";

export interface AnimeImportResult {
  created: boolean;
  anime: AnimeResponse;
}

// Concurrent imports of the same ID share one AniList round-trip and upsert.
const inFlight = new Map<number, Promise<AnimeImportResult>>();

function isMissingMediaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /returned no media|\b404\b|not found/i.test(message);
}

async function runImport(anilistId: number): Promise<AnimeImportResult> {
  try {
    const result = await withAnilistRetry(() => syncAnilistAnime(anilistId));
    // Queue the ID so the scheduled sync keeps it fresh and runs provider plugins.
    appendAnilistId(anilistId);
    return { created: result.created, anime: await getAnime(result.animeId) };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (isMissingMediaError(error)) throw notFound(`AniList has no anime with ID ${anilistId}`);
    console.error(`AniList import failed for ${anilistId}`, error);
    throw new HttpError(502, "AniList request failed");
  }
}

/** Fetches an AniList entry and creates or refreshes the matching anime. */
export function importAnilistAnime(anilistId: number): Promise<AnimeImportResult> {
  const active = inFlight.get(anilistId);
  if (active) return active;

  const pending = runImport(anilistId).finally(() => inFlight.delete(anilistId));
  inFlight.set(anilistId, pending);
  return pending;
}

/** Imports AniList's best search match for a title. */
export async function importAnilistAnimeBySearch(search: string): Promise<AnimeImportResult> {
  let anilistId: number | undefined;
  try {
    const result = await withAnilistRetry(() => anilistClient.anime.getAnimeBySearch(search, 1, 1));
    anilistId = result.Page?.media?.[0]?.id;
  } catch (error) {
    console.error(`AniList search failed for "${search}"`, error);
    throw new HttpError(502, "AniList request failed");
  }

  if (!anilistId) throw notFound(`AniList has no anime matching "${search}"`);
  return importAnilistAnime(anilistId);
}
