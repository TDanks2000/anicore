import { afterEach, describe, expect, test } from "bun:test";

import { fetchKitsuEpisodes, fetchKitsuEpisodeTitles, searchKitsuByTitle } from "./client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Kitsu GraphQL client", () => {
  test("keeps the non-null canonical title out of the search and episode queries", async () => {
    const requests: string[] = [];
    globalThis.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        requests.push(String(init?.body));
        const query = JSON.parse(String(init?.body)) as { query: string };
        const data = query.query.includes("searchAnimeByTitle")
          ? { searchAnimeByTitle: { nodes: [] } }
          : { findAnimeById: { episodes: { nodes: [] } } };
        return Response.json({ data });
      },
      { preconnect: () => undefined },
    );

    await searchKitsuByTitle("Cowboy Bebop");
    await fetchKitsuEpisodes("1");

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).not.toContain("canonical");
    }
  });

  test("fetches canonical episode titles separately and tolerates nulled records", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({
          data: {
            findAnimeById: {
              episodes: {
                nodes: [
                  { id: "229115", titles: { canonical: " Asteroid Blues " } },
                  null,
                  { id: "229114", titles: { canonical: "" } },
                ],
              },
            },
          },
          errors: [{ message: "Cannot return null for non-nullable field TitlesList.canonical" }],
        }),
      { preconnect: () => undefined },
    );

    expect([...(await fetchKitsuEpisodeTitles("1"))]).toEqual([["229115", "Asteroid Blues"]]);
  });
});
