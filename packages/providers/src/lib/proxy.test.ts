import { describe, expect, test } from "bun:test";
import { isProxyErrorPage, withProxyFallbackBudget } from "./proxy";

function response(status: number, contentType?: string) {
  return new Response(null, {
    status,
    headers: contentType ? { "content-type": contentType } : {},
  });
}

describe("free proxy error pages", () => {
  test("a proxy's own HTML or empty refusal is not an API answer", () => {
    expect(isProxyErrorPage(response(400, "text/html"))).toBe(true);
    expect(isProxyErrorPage(response(405))).toBe(true);
    expect(isProxyErrorPage(response(502, "text/html; charset=utf-8"))).toBe(true);
    expect(isProxyErrorPage(response(404, "text/html"))).toBe(true);
  });

  test("JSON errors and successful responses are preserved", () => {
    expect(isProxyErrorPage(response(400, "application/json"))).toBe(false);
    expect(isProxyErrorPage(response(429, "application/json; charset=utf-8"))).toBe(false);
    expect(isProxyErrorPage(response(404, "application/json"))).toBe(false);
    expect(isProxyErrorPage(response(200, "text/html"))).toBe(false);
  });
});

function waitForAbort(signal: AbortSignal): Promise<string> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("free proxy fallback budget", () => {
  test("a stalled pool falls back while the original request signal is still usable", async () => {
    const caller = new AbortController();
    const result = await withProxyFallbackBudget(
      waitForAbort,
      async () => {
        expect(caller.signal.aborted).toBe(false);
        return "direct";
      },
      caller.signal,
      5,
    );
    expect(result).toBe("direct");
  });

  test("caller cancellation does not start another request", async () => {
    const caller = new AbortController();
    let fallbackCalled = false;
    const result = withProxyFallbackBudget(
      waitForAbort,
      async () => {
        fallbackCalled = true;
        return "direct";
      },
      caller.signal,
      100,
    );
    caller.abort(new Error("cancelled"));
    await expect(result).rejects.toThrow("cancelled");
    expect(fallbackCalled).toBe(false);
  });

  test("successful proxy responses do not make a direct request", async () => {
    let fallbackCalled = false;
    expect(
      await withProxyFallbackBudget(
        async () => "proxy",
        async () => {
          fallbackCalled = true;
          return "direct";
        },
      ),
    ).toBe("proxy");
    expect(fallbackCalled).toBe(false);
  });
});
