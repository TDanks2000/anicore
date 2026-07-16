import { afterEach, describe, expect, test } from "bun:test";

import { fetchKitsuEpisodes, searchKitsuByTitle } from "./client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Kitsu GraphQL client", () => {
  test("does not request the unstable canonical title field", async () => {
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
});
