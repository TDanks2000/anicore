import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CrunchyrollAccessBlockedError, fetchSeries, resetCrunchyrollSession } from "./client";

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const series = { id: "GYVNXMVP6", slug_title: "cowboy-bebop", title: "Cowboy Bebop" };
const tokenResponse = () =>
  Response.json({ access_token: "anonymous-test-token", expires_in: 3600 });

beforeEach(resetCrunchyrollSession);
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  resetCrunchyrollSession();
});

describe("Crunchyroll anonymous client", () => {
  test("acquires an explicit anonymous device grant and reuses it for catalogue reads", async () => {
    let tokenCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/auth/v1/token")) {
        tokenCalls++;
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("client_id");
        expect(body.get("client_id")).toBe("cr_web");
        expect(body.get("device_id")).toBeTruthy();
        expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
        return tokenResponse();
      }
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer anonymous-test-token");
      return Response.json({ data: [series] });
    }) as unknown as typeof fetch;
    expect((await fetchSeries(series.id))?.title).toBe("Cowboy Bebop");
    await fetchSeries(series.id);
    expect(tokenCalls).toBe(1);
  });

  test("detects token challenges, redacts HTML and gates concurrent callers until cooldown expires", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        "<html><title>Just a moment...</title><script>private-challenge-value</script></html>",
        {
          status: 403,
          headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
        },
      );
    }) as unknown as typeof fetch;
    const results = await Promise.allSettled([
      fetchSeries(series.id),
      fetchSeries(series.id),
      fetchSeries(series.id),
    ]);
    expect(calls).toBe(1);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(CrunchyrollAccessBlockedError);
        expect(result.reason.message).not.toContain("<html>");
        expect(result.reason.message).not.toContain("private-challenge-value");
      }
    }
    const future = originalNow() + 16 * 60_000;
    Date.now = () => future;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls++;
      return String(input).endsWith("/auth/v1/token")
        ? tokenResponse()
        : Response.json({ data: [series] });
    }) as unknown as typeof fetch;
    expect((await fetchSeries(series.id))?.id).toBe(series.id);
    expect(calls).toBe(3);
  });

  test("detects catalogue challenge HTML without the mitigation header", async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls++;
      return String(input).endsWith("/auth/v1/token")
        ? tokenResponse()
        : new Response("<html><title>Just a moment...</title></html>", {
            status: 403,
            headers: { "content-type": "text/html" },
          });
    }) as unknown as typeof fetch;
    await expect(fetchSeries(series.id)).rejects.toBeInstanceOf(CrunchyrollAccessBlockedError);
    await expect(fetchSeries(series.id)).rejects.toBeInstanceOf(CrunchyrollAccessBlockedError);
    expect(calls).toBe(2);
  });

  test("ordinary forbidden JSON remains a hard error, not an access-challenge warning", async () => {
    globalThis.fetch = (async () =>
      Response.json({ error: "invalid_client" }, { status: 403 })) as unknown as typeof fetch;
    await expect(fetchSeries(series.id)).rejects.toThrow("invalid_client");
  });

  test("refreshes authentication once after a 401 and retains 404 semantics", async () => {
    let tokenCalls = 0;
    let reads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/auth/v1/token")) {
        tokenCalls++;
        return tokenResponse();
      }
      reads++;
      return new Response("", { status: reads === 1 ? 401 : 404 });
    }) as unknown as typeof fetch;
    expect(await fetchSeries(series.id)).toBeNull();
    expect(tokenCalls).toBe(2);
    expect(reads).toBe(2);
  });
});
