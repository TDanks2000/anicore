import { afterEach, describe, expect, test } from "bun:test";
import { fetchLanguageReviewQueue } from "./language-review-api";

const originalFetch = globalThis.fetch;
const filters = { languageCode: "", mediaType: "", status: "" } as const;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("review API client", () => {
  test("credentials travel only in the header, with filter pagination and no caching", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/admin/language-status/review-queue");
      expect(url.search).not.toContain("secret-token");
      expect(url.searchParams.get("offset")).toBe("25");
      expect(url.searchParams.get("languageCode")).toBe("pt-BR");
      expect(url.searchParams.get("includeAnime")).toBe("true");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret-token");
      expect(init?.cache).toBe("no-store");
      return new Response('[{"id":1,"anime":{"titleRomaji":"Example"}}]', {
        headers: { "X-Total-Count": "42" },
      });
    }) as unknown as typeof fetch;
    expect(
      (
        await fetchLanguageReviewQueue(
          "http://localhost:3000/",
          "secret-token",
          { ...filters, languageCode: " pt-BR ", mediaType: "audio" },
          2,
        )
      ).total,
    ).toBe(42);
  });
  test("rejects old deployments and distinguishes authentication failures", async () => {
    globalThis.fetch = (async () => new Response('[{"id":1}]')) as unknown as typeof fetch;
    await expect(fetchLanguageReviewQueue("http://localhost", "token", filters, 1)).rejects.toThrow(
      "Update the API first",
    );
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(
      fetchLanguageReviewQueue("http://localhost", "token", filters, 1),
    ).rejects.toMatchObject({ status: 401 });
    globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchLanguageReviewQueue("http://localhost", "token", filters, 1)).rejects.toThrow(
      "Configure ANICORE_ADMIN_TOKEN",
    );
  });
  test("missing totals are unknown, and cancellation aborts an in-flight session read", async () => {
    globalThis.fetch = (async () => new Response("[]")) as unknown as typeof fetch;
    expect(
      (await fetchLanguageReviewQueue("http://localhost", "token", filters, 1)).total,
    ).toBeNull();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })) as unknown as typeof fetch;
    const caller = new AbortController();
    const request = fetchLanguageReviewQueue(
      "http://localhost",
      "token",
      filters,
      1,
      caller.signal,
    );
    caller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});
