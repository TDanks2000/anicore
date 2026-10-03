import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "../app";
import {
  clearDashboardCache,
  getDashboardResources,
  previewCache,
  updateDashboardProxy,
} from "./dashboard-resources";
import { SyncMonitor } from "./sync-monitor";

let directory: string;
const originalCache = process.env.ANICORE_DASHBOARD_CACHE_DIR;
const originalConfig = process.env.ANICORE_PROXY_CONFIG_PATH;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "anicore-resources-"));
  process.env.ANICORE_DASHBOARD_CACHE_DIR = directory;
  process.env.ANICORE_PROXY_CONFIG_PATH = join(directory, "proxy-config.json");
});
afterEach(() => {
  if (originalCache === undefined) delete process.env.ANICORE_DASHBOARD_CACHE_DIR;
  else process.env.ANICORE_DASHBOARD_CACHE_DIR = originalCache;
  if (originalConfig === undefined) delete process.env.ANICORE_PROXY_CONFIG_PATH;
  else process.env.ANICORE_PROXY_CONFIG_PATH = originalConfig;
  rmSync(directory, { recursive: true, force: true });
});
test("resources paginate managed cache files and bound previews", () => {
  mkdirSync(join(directory, "jikan"));
  for (let i = 1; i <= 55; i++) writeFileSync(join(directory, "jikan", `${i}.json`), "{}");
  writeFileSync(join(directory, "private.txt"), "secret");
  writeFileSync(join(directory, "anilist_ids.txt"), "1\n".repeat(5000));
  expect(getDashboardResources().cache.totalFiles).toBe(56);
  expect(getDashboardResources().cache.files).toHaveLength(50);
  expect(getDashboardResources(50).cache.files).toHaveLength(6);
  expect(previewCache("anilist_ids.txt")).toMatchObject({ truncated: true });
  expect(previewCache("anilist_ids.txt").content.length).toBe(8192);
  expect(() => previewCache("../private.txt")).toThrow("Unknown cache file");
  expect(() => previewCache("private.txt")).toThrow("Unknown cache file");
  expect(() => clearDashboardCache("progress.json")).toThrow("read-only");
  clearDashboardCache("jikan/1.json");
  expect(existsSync(join(directory, "jikan", "1.json"))).toBe(false);
});
test("proxy settings persist, preserve credentials on unrelated changes, and redact responses", () => {
  updateDashboardProxy({ mode: "custom", url: "http://alice:secret@proxy.example:8080" });
  updateDashboardProxy({ maxAttempts: 5, mode: "direct" });
  const resources = getDashboardResources();
  expect(resources.proxy.effectiveMode).toBe("direct");
  expect(resources.proxy.maxAttempts).toBe(5);
  expect(JSON.stringify(resources)).not.toContain("secret");
  expect(JSON.stringify(resources)).not.toContain("alice");
  expect(JSON.parse(readFileSync(join(directory, "proxy-config.json"), "utf8")).url).toContain(
    "secret",
  );
  expect(() => updateDashboardProxy({ url: "socks5://proxy.example" })).toThrow(
    "Invalid proxy settings",
  );
  expect(() => updateDashboardProxy({ maxAttempts: 0 })).toThrow("Invalid proxy settings");
  writeFileSync(
    join(directory, "working_proxies.txt"),
    "http://alice:secret@proxy.example:8080\nhttp://alice:secret@proxy.example:8080\n",
  );
  expect(getDashboardResources().proxy.pools.working).toBe(1);
  expect(previewCache("working_proxies.txt").content).not.toContain("secret");
});

test("resource routes require monitor auth and block cache deletion during sync", async () => {
  const oldCode = process.env.ANICORE_SYNC_MONITOR_CODE;
  const oldMonitor = process.env.ANICORE_SYNC_MONITOR_DIR;
  process.env.ANICORE_SYNC_MONITOR_CODE = "resource-test-code";
  process.env.ANICORE_SYNC_MONITOR_DIR = join(directory, "monitor");
  try {
    const request = (path: string, method = "GET", body?: unknown, auth = true) =>
      app.handle(
        new Request(`http://localhost/sync-monitor/resources${path}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(auth ? { Authorization: "Bearer resource-test-code" } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    expect((await request("", "GET", undefined, false)).status).toBe(401);
    expect((await request("/proxy", "PATCH", { mode: "free" }, false)).status).toBe(401);
    expect(
      (await request("/cache/clear", "POST", { name: "kitsu_unmatched.txt" }, false)).status,
    ).toBe(401);
    expect(
      (await request("/proxy", "PATCH", { mode: "custom", url: "ftp://example.com" })).status,
    ).toBe(400);
    expect((await request("/proxy", "PATCH", { mode: "direct" })).status).toBe(200);
    writeFileSync(join(directory, "kitsu_unmatched.txt"), "1\t123\n");
    const monitor = new SyncMonitor({
      mode: "sync",
      total: 1,
      startIndex: 0,
      endIndex: 1,
      parallel: 1,
      providers: ["anilist"],
    });
    expect((await request("/cache/clear", "POST", { name: "kitsu_unmatched.txt" })).status).toBe(
      409,
    );
    expect(existsSync(join(directory, "kitsu_unmatched.txt"))).toBe(true);
    monitor.complete({ created: 0, updated: 0, failed: 0 });
    expect((await request("/cache/clear", "POST", { name: "kitsu_unmatched.txt" })).status).toBe(
      200,
    );
  } finally {
    if (oldCode === undefined) delete process.env.ANICORE_SYNC_MONITOR_CODE;
    else process.env.ANICORE_SYNC_MONITOR_CODE = oldCode;
    if (oldMonitor === undefined) delete process.env.ANICORE_SYNC_MONITOR_DIR;
    else process.env.ANICORE_SYNC_MONITOR_DIR = oldMonitor;
  }
});
