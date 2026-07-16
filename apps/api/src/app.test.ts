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

  test("returns safe global errors for unknown routes and invalid bodies", async () => {
    const notFound = await app.handle(
      new Request("http://localhost/does-not-exist"),
    );
    expect(notFound.status).toBe(404);
    expect(await json(notFound)).toEqual({ error: "Not found" });

    const invalidBody = await app.handle(
      new Request("http://localhost/anime/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ titleRomaji: 42, secret: "must-not-leak" }),
      }),
    );
    expect(invalidBody.status).toBe(400);
    expect(await json(invalidBody)).toEqual({ error: "Validation failed" });
  });

  test("rejects values that cannot be represented by the database schema", async () => {
    const fractionalEpisode = await app.handle(
      new Request("http://localhost/episodes/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ animeId: 1.5, number: 1.5 }),
      }),
    );
    expect(fractionalEpisode.status).toBe(400);
    expect(await json(fractionalEpisode)).toEqual({ error: "Validation failed" });

    const invalidMappingConfidence = await app.handle(
      new Request("http://localhost/mappings/anime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          animeId: 1,
          provider: "kitsu",
          providerId: "1",
          confidence: 101,
        }),
      }),
    );
    expect(invalidMappingConfidence.status).toBe(400);

    const emptyLanguage = await app.handle(
      new Request("http://localhost/admin/anime/1/language-evidence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          languageCode: "   ",
          mediaType: "audio",
          source: "manual",
          evidenceType: "manual_verified",
          value: "available",
        }),
      }),
    );
    expect(emptyLanguage.status).toBe(400);
  });

  test("does not allow cross-origin browser access by default", async () => {
    const response = await app.handle(
      new Request("http://localhost/admin/anime/1/language-override", {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.example",
          "Access-Control-Request-Method": "POST",
        },
      }),
    );

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
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
      control: {
        version: 1,
        command: null,
        requestedAt: null,
        requestedBy: null,
        message: null,
      },
      files: {
        statusExists: false,
        eventsExists: false,
        controlExists: false,
        runtimeConfigExists: false,
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
      status: {
        currentStage: string;
        currentAnilistId: number;
        lastError: string;
        progress: { processed: number; remaining: number; percent: number };
        runtimeConfig: { parallel: number; checkpointEvery: number };
      };
      files: {
        statusExists: boolean;
        eventsExists: boolean;
        controlExists: boolean;
        runtimeConfigExists: boolean;
      };
    };
    expect(statusPayload.status.currentStage).toBe("anilist-fetch");
    expect(statusPayload.status.currentAnilistId).toBe(123);
    expect(statusPayload.status.lastError).toBe("provider timeout");
    expect(statusPayload.status.progress).toMatchObject({
      processed: 0,
      remaining: 5,
      percent: 0,
    });
    expect(statusPayload.status.runtimeConfig).toMatchObject({
      parallel: 4,
      checkpointEvery: 10,
    });
    expect(statusPayload.files.statusExists).toBe(true);
    expect(statusPayload.files.eventsExists).toBe(true);
    expect(statusPayload.files.controlExists).toBe(true);
    expect(statusPayload.files.runtimeConfigExists).toBe(false);

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

  test("allows authenticated monitor config edits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anicore-monitor-"));
    process.env.ANICORE_SYNC_MONITOR_DIR = dir;
    process.env.ANICORE_SYNC_MONITOR_CODE = "test-code";

    const updateResponse = await app.handle(
      new Request("http://localhost/sync-monitor/config", {
        method: "PATCH",
        headers: {
          Authorization: "Bearer test-code",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          parallel: 3,
          checkpointEvery: 2,
          rateLimitMs: 250,
          startMode: "sync",
          startLimit: 25,
          startFromIndex: 10,
          refreshIds: true,
          resetAll: false,
        }),
      }),
    );

    expect(updateResponse.status).toBe(200);
    expect(await json(updateResponse)).toMatchObject({
      runtime: {
        parallel: 3,
        checkpointEvery: 2,
        rateLimitMs: 250,
        startMode: "sync",
        startLimit: 25,
        startFromIndex: 10,
        refreshIds: true,
        resetAll: false,
        updatedBy: "api",
      },
    });

    const invalidResponse = await app.handle(
      new Request("http://localhost/sync-monitor/config", {
        method: "PATCH",
        headers: {
          Authorization: "Bearer test-code",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ parallel: 0 }),
      }),
    );

    expect(invalidResponse.status).toBe(400);
    expect(await json(invalidResponse)).toEqual({
      error: "parallel must be between 1 and 32",
    });

    const configResponse = await app.handle(
      new Request("http://localhost/sync-monitor/config", {
        headers: { Authorization: "Bearer test-code" },
      }),
    );
    expect(configResponse.status).toBe(200);
    expect(await json(configResponse)).toMatchObject({
      runtime: {
        parallel: 3,
        checkpointEvery: 2,
        rateLimitMs: 250,
        startMode: "sync",
        startLimit: 25,
        startFromIndex: 10,
        refreshIds: true,
        resetAll: false,
        updatedBy: "api",
      },
    });

    rmSync(dir, { recursive: true, force: true });
  });

  test("writes authenticated sync control commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anicore-monitor-"));
    process.env.ANICORE_SYNC_MONITOR_DIR = dir;
    process.env.ANICORE_SYNC_MONITOR_CODE = "test-code";

    const inactivePause = await app.handle(
      new Request("http://localhost/sync-monitor/control/pause", {
        method: "POST",
        headers: { Authorization: "Bearer test-code" },
      }),
    );
    expect(inactivePause.status).toBe(409);
    expect(await json(inactivePause)).toEqual({
      error: "No active sync process to pause",
    });

    const monitor = new SyncMonitor({
      mode: "sync",
      total: 5,
      startIndex: 0,
      endIndex: 5,
      parallel: 1,
      providers: ["anilist"],
    });
    monitor.stage("anilist-fetch", 0, 1);

    const pause = await app.handle(
      new Request("http://localhost/sync-monitor/control/pause", {
        method: "POST",
        headers: { Authorization: "Bearer test-code" },
      }),
    );
    expect(pause.status).toBe(200);
    expect(await json(pause)).toMatchObject({
      active: true,
      control: { command: "pause", requestedBy: "api" },
    });

    const resume = await app.handle(
      new Request("http://localhost/sync-monitor/control/resume", {
        method: "POST",
        headers: { Authorization: "Bearer test-code" },
      }),
    );
    expect(resume.status).toBe(200);
    expect(await json(resume)).toMatchObject({
      active: true,
      control: { command: "resume", requestedBy: "api" },
    });

    const stop = await app.handle(
      new Request("http://localhost/sync-monitor/control/stop", {
        method: "POST",
        headers: { Authorization: "Bearer test-code" },
      }),
    );
    expect(stop.status).toBe(200);
    expect(await json(stop)).toMatchObject({
      active: true,
      control: { command: "stop", requestedBy: "api" },
    });

    rmSync(dir, { recursive: true, force: true });
  });
});
