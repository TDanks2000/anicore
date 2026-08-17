import { describe, expect, test } from "bun:test";

import { classifyPotentiallyMutatingAnimeRead } from "./public-anime-read-routing";

describe("public anime read routing", () => {
	test("classifies title searches that can fall through to AniList sync", () => {
		expect(
			classifyPotentiallyMutatingAnimeRead(
				"GET",
				"http://localhost/anime?q=%20Cowboy%20Bebop%20&limit=25",
			),
		).toEqual({ kind: "search", search: "Cowboy Bebop", limit: 25 });
	});

	test("uses the normal bounded limit parsing for public search results", () => {
		expect(
			classifyPotentiallyMutatingAnimeRead(
				"GET",
				"http://localhost/anime/?q=test&limit=9999",
			),
		).toEqual({ kind: "search", search: "test", limit: 100 });
	});

	test("classifies only AniList provider lookups as potentially mutating", () => {
		expect(
			classifyPotentiallyMutatingAnimeRead(
				"GET",
				"http://localhost/anime/by/anilist/1",
			),
		).toEqual({ kind: "anilist-mapping", providerId: "1" });

		expect(
			classifyPotentiallyMutatingAnimeRead(
				"GET",
				"http://localhost/anime/by/kitsu/1",
			),
		).toBeNull();
	});

	test("does not intercept normal list/detail reads or write methods", () => {
		expect(
			classifyPotentiallyMutatingAnimeRead(
				"GET",
				"http://localhost/anime?limit=10",
			),
		).toBeNull();
		expect(
			classifyPotentiallyMutatingAnimeRead(
				"GET",
				"http://localhost/anime/123",
			),
		).toBeNull();
		expect(
			classifyPotentiallyMutatingAnimeRead(
				"POST",
				"http://localhost/anime?q=test",
			),
		).toBeNull();
	});
});
