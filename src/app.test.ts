import { afterAll, describe, expect, test } from "bun:test";

import { app } from "./app";
import { closeDb } from "./db";

async function json(response: Response): Promise<unknown> {
  return response.json();
}

describe("app contract", () => {
  afterAll(async () => {
    await closeDb();
  });

  test("reports health", async () => {
    const response = await app.handle(new Request("http://localhost/health/"));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true, name: "anicore" });
  });

  test("returns 400 for invalid anime ids", async () => {
    const response = await app.handle(new Request("http://localhost/anime/nope"));

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: "Invalid anime id" });
  });

  test("returns 400 for invalid episode ids", async () => {
    const response = await app.handle(
      new Request("http://localhost/episodes/nope"),
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: "Invalid episode id" });
  });
});
