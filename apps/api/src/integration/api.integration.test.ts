import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb } from "@anicore/db";

import { app } from "../app";
import { describeWithDatabase, resetTestDatabase } from "../test/database";

const TOKEN = "integration-admin-token";

type Json = Record<string, unknown> & { id?: number };
// biome-ignore lint/suspicious/noExplicitAny: response bodies are asserted structurally by the tests
type ResponseBody = any;

async function call(method: string, path: string, body?: unknown) {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as ResponseBody };
}

const get = (path: string) => call("GET", path);
const post = (path: string, body: unknown) => call("POST", path, body);
const patch = (path: string, body: unknown) => call("PATCH", path, body);
const del = (path: string) => call("DELETE", path);

async function createAnime(body: Record<string, unknown>): Promise<number> {
  const response = await post("/anime", body);
  expect(response.status).toBe(200);
  return response.body.id!;
}

describeWithDatabase("API against Postgres", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    process.env.ANICORE_ADMIN_TOKEN = TOKEN;
  });

  afterAll(async () => {
    delete process.env.ANICORE_ADMIN_TOKEN;
    await closeDb();
  });

  test("reports database readiness", async () => {
    expect(await get("/health/ready")).toEqual({
      status: 200,
      body: { ok: true, database: "up" },
    });
  });

  describe("anime", () => {
    test("creates, reads and 404s", async () => {
      const id = await createAnime({
        titleRomaji: "Cowboy Bebop",
        slug: " cowboy-bebop ",
        genres: ["Action"],
      });

      const read = await get(`/anime/${id}`);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({
        titleRomaji: "Cowboy Bebop",
        slug: "cowboy-bebop",
        genres: ["Action"],
        synonyms: [],
      });
      expect(read.body).not.toHaveProperty("genresJson");

      expect(await get("/anime/999")).toEqual({ status: 404, body: { error: "Anime not found" } });
      expect((await get("/anime/999/mappings")).status).toBe(404);
    });

    test("rejects a duplicate slug with 409", async () => {
      await createAnime({ titleRomaji: "A", slug: "same" });
      expect(await post("/anime", { titleRomaji: "B", slug: "same" })).toEqual({
        status: 409,
        body: { error: "An anime with this slug already exists" },
      });
    });

    test("searches literally, ranks exact and prefix matches first, and paginates", async () => {
      await createAnime({ titleRomaji: "Naruto Shippuden", popularity: 900 });
      await createAnime({ titleRomaji: "Boruto: Naruto Next Generations", popularity: 1000 });
      await createAnime({ titleRomaji: "Naruto", popularity: 10 });
      await createAnime({ titleRomaji: "100% Pascal-sensei" });
      await createAnime({ titleRomaji: "Something Else", synonyms: ["Naruto Alt"] });

      const titles = async (query: string) =>
        (await get(`/anime?${query}`)).body.map((row: Json) => row.titleRomaji);

      expect(await titles("q=naruto")).toEqual([
        "Naruto",
        "Naruto Shippuden",
        "Boruto: Naruto Next Generations",
        "Something Else",
      ]);
      expect(await titles("q=naruto&limit=2&offset=1")).toEqual([
        "Naruto Shippuden",
        "Boruto: Naruto Next Generations",
      ]);
      // "%" and "_" are data, not wildcards.
      expect(await titles("q=100%25")).toEqual(["100% Pascal-sensei"]);
      expect(await titles("q=%25")).toEqual(["100% Pascal-sensei"]);
      expect(await titles("q=_")).toEqual([]);
    });

    test("lists in id order and filters by catalogue fields", async () => {
      await createAnime({ titleRomaji: "Movie", format: "MOVIE", seasonYear: 2001 });
      await createAnime({ titleRomaji: "Show", format: "TV", seasonYear: 2001, season: "SPRING" });
      await createAnime({ titleRomaji: "Later", format: "TV", seasonYear: 2002 });

      const titles = async (query: string) =>
        (await get(`/anime?${query}`)).body.map((row: Json) => row.titleRomaji);

      expect(await titles("")).toEqual(["Movie", "Show", "Later"]);
      expect(await titles("format=tv")).toEqual(["Show", "Later"]);
      expect(await titles("seasonYear=2001&season=spring")).toEqual(["Show"]);
      expect((await get("/anime?limit=101")).status).toBe(400);
    });

    test("GET lookups never import: an unknown AniList ID is a plain 404", async () => {
      expect(await get("/anime/by/anilist/1")).toEqual({
        status: 404,
        body: { error: "Anime not found" },
      });
    });

    test("returns the full aggregate with ordered children", async () => {
      const id = await createAnime({
        titleRomaji: "Full",
        mappings: [{ provider: "anilist", providerId: "1" }],
      });
      await post("/episodes", { animeId: id, number: 2 });
      await post("/episodes", { animeId: id, number: 1 });

      const full = await get(`/anime/${id}/full`);
      expect(full.status).toBe(200);
      expect((full.body.episodes as Json[]).map((episode) => episode.number)).toEqual([1, 2]);
      expect(full.body.mappings).toMatchObject([
        { provider: "anilist", providerId: "1", isPrimary: true },
      ]);
    });
  });

  describe("anime mappings", () => {
    test("makes a provider's first mapping primary and resolves lookups", async () => {
      const id = await createAnime({ titleRomaji: "Mapped" });

      const created = await post("/mappings/anime", {
        animeId: id,
        provider: "kitsu",
        providerId: " 42 ",
      });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({ providerId: "42", isPrimary: true });

      const byMapping = await get("/anime/by/kitsu/42");
      expect(byMapping.body).toMatchObject({ id, mapping: { providerId: "42" } });

      const lookup = await get("/mappings/anime/kitsu/42");
      expect(lookup.body).toMatchObject({ anime: { id, genres: [] } });
      expect((await get("/mappings/anime/kitsu/43")).status).toBe(404);
    });

    test("keeps exactly one primary per provider through promote, demote and delete", async () => {
      const id = await createAnime({ titleRomaji: "Split cour" });
      await post("/mappings/anime", { animeId: id, provider: "thetvdb", providerId: "1" });

      const second = await post("/mappings/anime", {
        animeId: id,
        provider: "thetvdb",
        providerId: "2",
      });
      expect(second.body).toMatchObject({ isPrimary: false });

      const promoted = await patch("/mappings/anime/thetvdb/2", { isPrimary: true });
      expect(promoted.body).toMatchObject({ isPrimary: true });
      const mappings = (await get(`/anime/${id}/mappings`)).body;
      expect(mappings.map((m: Json) => [m.providerId, m.isPrimary])).toEqual([
        ["2", true],
        ["1", false],
      ]);

      expect(await patch("/mappings/anime/thetvdb/2", { isPrimary: false })).toMatchObject({
        status: 409,
      });
      expect(await del("/mappings/anime/thetvdb/2")).toMatchObject({ status: 409 });

      expect((await del("/mappings/anime/thetvdb/1")).status).toBe(200);
      expect((await del("/mappings/anime/thetvdb/2")).status).toBe(200);
      expect((await del("/mappings/anime/thetvdb/2")).status).toBe(404);
    });

    test("rejects ambiguous primaries on anime creation", async () => {
      const response = await post("/anime", {
        titleRomaji: "Ambiguous",
        mappings: [
          { provider: "thetvdb", providerId: "1" },
          { provider: "thetvdb", providerId: "2" },
        ],
      });
      expect(response).toEqual({
        status: 400,
        body: { error: "Multiple thetvdb mappings require exactly one primary mapping" },
      });
    });

    test("rejects a provider identity already owned by another anime", async () => {
      const first = await createAnime({ titleRomaji: "First" });
      const second = await createAnime({ titleRomaji: "Second" });
      await post("/mappings/anime", { animeId: first, provider: "mal", providerId: "5" });

      expect(
        await post("/mappings/anime", { animeId: second, provider: "mal", providerId: "5" }),
      ).toEqual({
        status: 409,
        body: { error: "Mapping already exists or belongs to another record" },
      });
      expect(
        (await post("/mappings/anime", { animeId: 999, provider: "mal", providerId: "6" })).status,
      ).toBe(404);
    });
  });

  describe("episodes", () => {
    test("requires an anime-level mapping before episode mappings", async () => {
      const id = await createAnime({ titleRomaji: "Episodes" });

      const refused = await post("/episodes", {
        animeId: id,
        number: 1,
        mappings: [{ provider: "kitsu", providerId: "e1" }],
      });
      expect(refused).toEqual({
        status: 409,
        body: { error: "Create an anime-level kitsu mapping before adding kitsu episode mappings" },
      });
      // The transaction rolled back: no orphan episode was left behind.
      expect((await get(`/anime/${id}/episodes`)).body).toEqual([]);

      await post("/mappings/anime", { animeId: id, provider: "kitsu", providerId: "a1" });
      const created = await post("/episodes", {
        animeId: id,
        number: 1,
        mappings: [{ provider: "kitsu", providerId: " e1 " }],
      });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({ displayNumber: "1", sortNumber: 1, kind: "normal" });

      const lookup = await get("/mappings/episode/kitsu/e1");
      expect(lookup.body).toMatchObject({ episode: { id: created.body.id } });

      const updated = await patch("/mappings/episode/kitsu/e1", { providerEpisodeNumber: " 7 " });
      expect(updated.body).toMatchObject({ providerEpisodeNumber: "7" });

      expect(await del("/mappings/anime/kitsu/a1")).toMatchObject({ status: 409 });
      expect((await del("/mappings/episode/kitsu/e1")).status).toBe(200);
      expect((await del("/mappings/anime/kitsu/a1")).status).toBe(200);
    });

    test("maps missing parents and duplicates onto 404 and 409", async () => {
      expect(await post("/episodes", { animeId: 999, number: 1 })).toEqual({
        status: 404,
        body: { error: "Anime not found" },
      });

      const id = await createAnime({ titleRomaji: "Dupes" });
      await post("/episodes", { animeId: id, number: 1 });
      expect((await post("/episodes", { animeId: id, number: 1 })).status).toBe(409);
      expect((await post("/episodes", { animeId: id, number: 1, kind: "special" })).status).toBe(
        200,
      );
      expect((await get("/episodes/999")).status).toBe(404);
    });

    test("records language statuses and rolls them up to the anime", async () => {
      const id = await createAnime({ titleRomaji: "Dubbed" });
      const episode = await post("/episodes", {
        animeId: id,
        number: 1,
        languageStatuses: [{ languageCode: "EN", mediaType: "audio", status: "available" }],
      });

      const full = await get(`/episodes/${episode.body.id}/full`);
      expect(full.body.languageStatuses).toMatchObject([
        { languageCode: "en", mediaType: "audio", status: "available", provider: "manual" },
      ]);

      const dub = await get(`/anime/${id}/dub-status`);
      expect(dub.status).toBe(200);
      expect(dub.body).toMatchObject({ animeId: id, languageCode: "en", mediaType: "audio" });
      expect((dub.body.evidence as Json[]).length).toBeGreaterThan(0);
    });
  });

  describe("language status administration", () => {
    test("applies overrides and exposes the review queue to admins", async () => {
      const id = await createAnime({ titleRomaji: "Override" });
      const override = await post(`/admin/anime/${id}/language-override`, {
        languageCode: "en",
        mediaType: "audio",
        status: "confirmed",
      });
      expect(override.body).toMatchObject({ status: "confirmed", isManualOverride: true });

      expect((await get("/admin/language-status/review-queue")).status).toBe(200);
      expect(
        (
          await post("/admin/anime/999/language-override", {
            languageCode: "en",
            mediaType: "audio",
            status: "confirmed",
          })
        ).status,
      ).toBe(404);
    });
  });
});
