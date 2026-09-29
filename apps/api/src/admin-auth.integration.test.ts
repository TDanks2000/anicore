import { afterEach, describe, expect, test } from "bun:test";

import { app } from "./app";

function post(path: string, headers: Record<string, string> = {}) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ titleRomaji: "Protected write" }),
    }),
  );
}

describe("global admin guard", () => {
  afterEach(() => {
    delete process.env.ANICORE_ADMIN_TOKEN;
  });

  test("fails closed when the admin token is not configured", async () => {
    const response = await post("/anime/");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Admin routes are disabled until ANICORE_ADMIN_TOKEN is configured",
    });
  });

  test("rejects a write with the wrong token before validating its body", async () => {
    process.env.ANICORE_ADMIN_TOKEN = "test-admin-token";

    const response = await app.handle(
      new Request("http://localhost/anime/", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token", "Content-Type": "application/json" },
        body: "{ not json",
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="AniCore Admin"');
    expect(await response.json()).toEqual({ error: "Invalid admin token" });
  });

  test("protects admin reads", async () => {
    process.env.ANICORE_ADMIN_TOKEN = "test-admin-token";

    const response = await app.handle(
      new Request("http://localhost/admin/language-status/review-queue"),
    );
    expect(response.status).toBe(401);
  });

  test("keeps CORS headers on rejected cross-origin writes from allowed origins", async () => {
    const response = await post("/anime/", { Origin: "http://localhost:5173" });

    expect(response.status).toBe(503);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });
});
