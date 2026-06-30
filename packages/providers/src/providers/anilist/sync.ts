import { upsertAnimeFromProvider } from "../index";
import { anilistClient } from "./client";
import { mapAnilistAnime } from "./mapper";
import type { ProviderAnimeData, ProviderRelation } from "../types";

/** Fetch + map an AniList entry without touching the database. */
export async function fetchAnilistAnime(id: number): Promise<ProviderAnimeData> {
  const [mediaResult, relationsResult] = await Promise.all([
    anilistClient.anime.getAnimeById(id),
    anilistClient.anime.getRelations(id).catch(() => null),
  ]);

  if (!mediaResult.Media) {
    throw new Error(`AniList returned no media for ID ${id}`);
  }

  const data = mapAnilistAnime(mediaResult.Media);

  const relations: ProviderRelation[] = (relationsResult?.Media?.relations?.edges ?? [])
    .filter(
      (e): e is NonNullable<typeof e> =>
        e !== null &&
        e.node !== null &&
        (e.node.type as string) === "ANIME" &&
        e.relationType !== null,
    )
    .map((e) => ({
      anilistId: e.node!.id,
      relationType: String(e.relationType!).toLowerCase(),
    }));

  if (relations.length) {
    data.relations = relations;
  }

  return data;
}

export async function syncAnilistAnime(
  id: number,
): Promise<{ animeId: number; created: boolean; data: ProviderAnimeData }> {
  const data = await fetchAnilistAnime(id);
  const { animeId, created } = await upsertAnimeFromProvider(data);
  return { animeId, created, data };
}
