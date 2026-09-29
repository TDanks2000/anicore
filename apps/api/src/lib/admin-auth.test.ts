import { afterEach, describe, expect, test } from "bun:test";

import { authorizeAdminRequest, requiresAdmin } from "./admin-auth";

describe("requiresAdmin", () => {
  test("leaves public reads open", () => {
    expect(requiresAdmin("GET", "/anime/1")).toBe(false);
    expect(requiresAdmin("HEAD", "/episodes")).toBe(false);
  });

  test("protects every write", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      expect(requiresAdmin(method, "/anime")).toBe(true);
    }
  });

  test("protects reads under /admin but not CORS preflight", () => {
    expect(requiresAdmin("GET", "/admin/language-status/review-queue")).toBe(true);
    expect(requiresAdmin("GET", "/admin")).toBe(true);
    expect(requiresAdmin("OPTIONS", "/admin/anime/1/language-override")).toBe(false);
    expect(requiresAdmin("GET", "/administrator")).toBe(false);
  });

  test("leaves the sync monitor to its own access-code guard", () => {
    expect(requiresAdmin("POST", "/sync-monitor/control/pause")).toBe(false);
    expect(requiresAdmin("PATCH", "/sync-monitor/config")).toBe(false);
  });
});

describe("authorizeAdminRequest", () => {
  afterEach(() => {
    delete process.env.ANICORE_ADMIN_TOKEN;
  });

  test("allows public reads without a token", () => {
    expect(authorizeAdminRequest({ method: "GET", pathname: "/anime/1", headers: {} })).toEqual({
      ok: true,
    });
  });

  test("fails closed when no admin token is configured", () => {
    expect(authorizeAdminRequest({ method: "POST", pathname: "/anime", headers: {} })).toEqual({
      ok: false,
      status: 503,
      error: "Admin routes are disabled until ANICORE_ADMIN_TOKEN is configured",
    });
  });

  test("accepts bearer and explicit admin-token headers", () => {
    process.env.ANICORE_ADMIN_TOKEN = "test-admin-token";

    expect(
      authorizeAdminRequest({
        method: "PATCH",
        pathname: "/admin/anime/1/language-override",
        headers: { authorization: "Bearer test-admin-token" },
      }),
    ).toEqual({ ok: true });

    expect(
      authorizeAdminRequest({
        method: "DELETE",
        pathname: "/future-admin-route",
        headers: { "x-anicore-admin-token": "test-admin-token" },
      }),
    ).toEqual({ ok: true });
  });

  test("rejects missing, empty and wrong tokens", () => {
    process.env.ANICORE_ADMIN_TOKEN = "test-admin-token";
    const rejected = { ok: false, status: 401, error: "Invalid admin token" } as const;

    for (const headers of [
      {},
      { authorization: "Bearer " },
      { authorization: "Bearer wrong-token" },
      { authorization: "Basic dGVzdC1hZG1pbi10b2tlbg==" },
    ]) {
      expect(authorizeAdminRequest({ method: "POST", pathname: "/episodes", headers })).toEqual(
        rejected,
      );
    }
  });
});
