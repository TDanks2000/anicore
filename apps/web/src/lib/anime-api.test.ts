import { afterEach, describe, expect, test } from "bun:test";

import { buildAnimeListParams, fetchAnimeList } from "./anime-api";
import { DEFAULT_ANIME_QUERY } from "./anime-query";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("anime api", () => {
  test("caller cancellation aborts catalogue reads", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init!.signal!;
      return new Promise<Response>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    const caller = new AbortController();
    const request = fetchAnimeList("http://localhost:3000", DEFAULT_ANIME_QUERY, caller.signal);
    caller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  test("builds list params, omitting empty filters and mapping the page to an offset", () => {
    const params = buildAnimeListParams({
      ...DEFAULT_ANIME_QUERY,
      q: "  naruto  ",
      format: "TV",
      seasonYear: "2005",
      page: 3,
      pageSize: 25,
      sort: "score",
      order: "desc",
    });

    expect(params.get("q")).toBe("naruto");
    expect(params.get("format")).toBe("TV");
    expect(params.get("seasonYear")).toBe("2005");
    expect(params.get("season")).toBeNull();
    expect(params.get("status")).toBeNull();
    expect(params.get("offset")).toBe("50");
    expect(params.get("limit")).toBe("25");
    expect(params.get("sort")).toBe("score");
    expect(params.get("order")).toBe("desc");
  });

  test("reads items and the total header from the API", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify([{ id: 1, titleRomaji: "Show" }]), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Total-Count": "42" },
      });
    }) as typeof fetch;

    const result = await fetchAnimeList("http://localhost:3000/", DEFAULT_ANIME_QUERY);

    expect(requestedUrl).toBe(
      "http://localhost:3000/anime?limit=50&offset=0&sort=id&order=asc&projection=summary",
    );
    expect(result.total).toBe(42);
    expect(result.items).toHaveLength(1);
  });

  test("treats a missing total header as unknown", async () => {
    globalThis.fetch = (async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;

    expect((await fetchAnimeList("http://localhost:3000", DEFAULT_ANIME_QUERY)).total).toBeNull();
  });

  test("surfaces the API error message", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Validation failed" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(fetchAnimeList("http://localhost:3000", DEFAULT_ANIME_QUERY)).rejects.toThrow(
      "Validation failed",
    );
  });
});
