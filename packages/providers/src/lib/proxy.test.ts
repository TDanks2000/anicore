import { describe, expect, test } from "bun:test";
import { isProxyErrorPage } from "./proxy";

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
  });

  test("JSON errors, successes and 404 pages come from the API", () => {
    expect(isProxyErrorPage(response(400, "application/json"))).toBe(false);
    expect(isProxyErrorPage(response(429, "application/json; charset=utf-8"))).toBe(false);
    expect(isProxyErrorPage(response(404, "text/html"))).toBe(false);
    expect(isProxyErrorPage(response(200, "text/html"))).toBe(false);
  });
});
