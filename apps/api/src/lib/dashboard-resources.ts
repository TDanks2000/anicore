import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AnilistIdsRefreshResult, refreshAnilistIdsFile } from "@anicore/providers/lib/cache";
import { maskProxyUrl, readProxySettings, writeProxySettings } from "@anicore/providers/lib/proxy";
import type { DashboardProxyPatch, DashboardResources } from "@anicore/sync-monitor";
import { HttpError } from "./errors";

const ROOT_FILES = new Set([
  "anilist_ids.txt",
  "progress.json",
  "proxies.txt",
  "proxies_ts",
  "working_proxies.txt",
  "dead_proxies.txt",
  "kitsu_unmatched.txt",
  "animeschedule_unmatched.txt",
  "thetvdb_unmatched.txt",
  "tmdb_unmatched.txt",
]);
export function cacheRoot(): string {
  return (
    process.env.ANICORE_DASHBOARD_CACHE_DIR ||
    fileURLToPath(new URL("../../data/cache", import.meta.url))
  );
}
function allowed(name: string): boolean {
  return ROOT_FILES.has(name) || /^jikan\/[1-9]\d*\.json$/.test(name);
}
function cachePath(name: string): string {
  if (!allowed(name)) throw new HttpError(400, "Unknown cache file");
  const root = cacheRoot();
  if (existsSync(root) && lstatSync(root).isSymbolicLink())
    throw new HttpError(400, "Cache links are not supported");
  if (
    name.startsWith("jikan/") &&
    existsSync(join(root, "jikan")) &&
    lstatSync(join(root, "jikan")).isSymbolicLink()
  )
    throw new HttpError(400, "Cache links are not supported");
  const path = join(root, name);
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
    throw new HttpError(400, "Cache links are not supported");
  return path;
}
function cacheNames(): string[] {
  const root = cacheRoot();
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink()) throw new HttpError(400, "Cache links are not supported");
  const names = readdirSync(root).filter((name) => ROOT_FILES.has(name));
  const jikan = join(root, "jikan");
  if (existsSync(jikan) && lstatSync(jikan).isDirectory() && !lstatSync(jikan).isSymbolicLink())
    names.push(
      ...readdirSync(jikan)
        .map((name) => `jikan/${name}`)
        .filter(allowed),
    );
  return names
    .filter((name) => {
      const stat = lstatSync(join(root, name));
      return stat.isFile() && !stat.isSymbolicLink();
    })
    .sort();
}
export function previewCache(name: string) {
  const path = cachePath(name);
  if (!existsSync(path)) throw new HttpError(404, "Cache file no longer exists");
  const buffer = Buffer.alloc(8192);
  const fd = openSync(path, "r");
  let count: number;
  try {
    count = readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  let content = buffer.subarray(0, count).toString("utf8");
  if (["proxies.txt", "working_proxies.txt", "dead_proxies.txt"].includes(name))
    content = content.split(/\r?\n/).filter(Boolean).map(maskProxyUrl).join("\n");
  return { name, content, truncated: lstatSync(path).size > count };
}
export function getDashboardResources(offset = 0): DashboardResources {
  const settings = readProxySettings();
  const envProxy = ["ANICORE_PROXY_URL", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
    .map((key) => process.env[key]?.trim())
    .find(Boolean);
  const free = /^(1|true|yes)$/i.test(process.env.ANICORE_USE_FREE_PROXY ?? "");
  const effectiveMode =
    settings.mode === "environment"
      ? envProxy
        ? "custom"
        : free
          ? "free"
          : "direct"
      : settings.mode;
  const names = cacheNames();
  const files = names.map((name) => {
    const stat = lstatSync(cachePath(name));
    return {
      name,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      clearable: name.endsWith("_unmatched.txt") || name.startsWith("jikan/"),
    };
  });
  const countPool = (name: string) => {
    const path = cachePath(name);
    if (!existsSync(path)) return 0;
    // Pool files are small text files; count unique non-empty entries.
    return new Set(
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ).size;
  };
  return {
    proxy: {
      mode: settings.mode,
      noProxy: settings.noProxy,
      maxAttempts: settings.maxAttempts,
      timeoutMs: settings.timeoutMs,
      hasCustomUrl: Boolean(settings.url),
      address: settings.url ? maskProxyUrl(settings.url) : null,
      effectiveMode,
      effectiveAddress:
        effectiveMode === "custom"
          ? maskProxyUrl(settings.mode === "environment" ? envProxy! : settings.url)
          : null,
      pools: {
        untested: countPool("proxies.txt"),
        working: countPool("working_proxies.txt"),
        dead: countPool("dead_proxies.txt"),
      },
    },
    cache: {
      files: files.slice(offset, offset + 50),
      offset,
      totalFiles: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    },
  };
}

export function updateDashboardProxy(patch: DashboardProxyPatch): void {
  const previous = readProxySettings();
  try {
    writeProxySettings({
      ...previous,
      ...patch,
      url: patch.url === undefined ? previous.url : patch.url,
    });
  } catch {
    throw new HttpError(
      400,
      "Invalid proxy settings. Use an HTTP(S) URL, 1–100 attempts and a 100–60000 ms timeout.",
    );
  }
}
export function clearDashboardCache(name: string): void {
  const path = cachePath(name);
  if (!(name.endsWith("_unmatched.txt") || name.startsWith("jikan/")))
    throw new HttpError(400, "This cache file is read-only");
  if (existsSync(path)) unlinkSync(path);
}

/** Replaces the dashboard's AniList ID list with the GitHub source. */
export function refreshDashboardAnilistIds(): Promise<AnilistIdsRefreshResult> {
  return refreshAnilistIdsFile(cachePath("anilist_ids.txt"));
}
