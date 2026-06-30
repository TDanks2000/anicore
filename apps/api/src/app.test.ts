import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { app } from "./app";
import { closeDb } from "@anicore/db";
import { SyncMonitor } from "./lib/sync-monitor";

async function json(response: Response): Promise<unknown> {
  return response.json();
}

describe("app contract", () => {
  afterAll(async () => {
    await closeDb();
  });

  afterEach(() => {
    delete process.env.ANICORE_SYNC_MONITOR_CODE;
    delete process.env.ANICORE_SYNC_MONITOR_DIR;
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

  test("guards sync monitor endpoints until a valid code is supplied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anicore-monitor-"));
    process.env.ANICORE_SYNC_MONITOR_DIR = dir;
    process.env.ANICORE_SYNC_MONITOR_CODE = "test-code";

    const unauthorized = await app.handle(
      new Request("http://localhost/sync-monitor/"),
    );
    expect(unauthorized.status).toBe(401);
    expect(await json(unauthorized)).toEqual({
      error: "Invalid sync monitor code",
    });

    const authorized = await app.handle(
      new Request("http://localhost/sync-monitor/", {
        headers: { Authorization: "Bearer test-code" },
      }),
    );
    expect(authorized.status).toBe(200);
    expect(await json(authorized)).toEqual({
      status: null,
      active: false,
      files: {
        statusExists: false,
        eventsExists: false,
        statusUpdatedAt: null,
      },
    });

    rmSync(dir, { recursive: true, force: true });
  });

  test("returns file-backed sync monitor status and events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anicore-monitor-"));
    process.env.ANICORE_SYNC_MONITOR_DIR = dir;
    process.env.ANICORE_SYNC_MONITOR_CODE = "test-code";

    const monitor = new SyncMonitor({
      mode: "sync",
      total: 5,
      startIndex: 1,
      endIndex: 6,
      parallel: 2,
      providers: ["anilist", "kitsu"],
    });
    monitor.stage("anilist-fetch", 1, 123);
    monitor.recordError("provider timeout", 1, 123);

    const statusResponse = await app.handle(
      new Request("http://localhost/sync-monitor/", {
        headers: { Authorization: "Basic " + btoa("anicore:test-code") },
      }),
    );
    expect(statusResponse.status).toBe(200);
    const statusPayload = (await json(statusResponse)) as {
      status: { currentStage: string; currentAnilistId: number; lastError: string };
      files: { statusExists: boolean; eventsExists: boolean };
    };
    expect(statusPayload.status.currentStage).toBe("anilist-fetch");
    expect(statusPayload.status.currentAnilistId).toBe(123);
    expect(statusPayload.status.lastError).toBe("provider timeout");
    expect(statusPayload.files.statusExists).toBe(true);
    expect(statusPayload.files.eventsExists).toBe(true);

    const eventsResponse = await app.handle(
      new Request("http://localhost/sync-monitor/events?limit=1", {
        headers: { "X-Sync-Monitor-Code": "test-code" },
      }),
    );
    expect(eventsResponse.status).toBe(200);
    expect(await json(eventsResponse)).toMatchObject({
      events: [{ level: "error", message: "provider timeout" }],
    });

    rmSync(dir, { recursive: true, force: true });
  });
});
