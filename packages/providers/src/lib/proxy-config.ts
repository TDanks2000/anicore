import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProxySettings {
  mode: "environment" | "direct" | "custom" | "free";
  url: string;
  noProxy: string;
  maxAttempts: number;
  timeoutMs: number;
}

export function proxySettingsPath(): string {
  return (
    process.env.ANICORE_PROXY_CONFIG_PATH ||
    fileURLToPath(
      new URL("../../../../apps/api/data/sync-monitor/proxy-config.json", import.meta.url),
    )
  );
}

export function readProxySettings(): ProxySettings {
  const defaults: ProxySettings = {
    mode: "environment",
    url: "",
    noProxy: process.env.NO_PROXY ?? process.env.no_proxy ?? "",
    maxAttempts: positiveEnv("ANICORE_FREE_PROXY_MAX_ATTEMPTS", 25),
    timeoutMs: positiveEnv("ANICORE_PROXY_ATTEMPT_TIMEOUT_MS", 15_000),
  };
  const path = proxySettingsPath();
  if (!existsSync(path)) return defaults;
  // Never silently fall back to environment routing if a saved config is damaged.
  return validateProxySettings(JSON.parse(readFileSync(path, "utf8")));
}

function positiveEnv(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

export function validateProxySettings(value: unknown): ProxySettings {
  const config = value as ProxySettings;
  if (!config || !["environment", "direct", "custom", "free"].includes(config.mode))
    throw new Error("Invalid proxy mode");
  if (
    typeof config.url !== "string" ||
    typeof config.noProxy !== "string" ||
    config.noProxy.length > 4096
  )
    throw new Error("Invalid proxy address or bypass list");
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > 100)
    throw new Error("Proxy attempts must be between 1 and 100");
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 60_000)
    throw new Error("Proxy timeout must be between 100 and 60000 ms");
  if (config.url) {
    const url = new URL(config.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Use an HTTP or HTTPS proxy URL without a path");
  }
  if (config.mode === "custom" && !config.url) throw new Error("A custom proxy URL is required");
  return {
    mode: config.mode,
    url: config.url,
    noProxy: config.noProxy,
    maxAttempts: config.maxAttempts,
    timeoutMs: config.timeoutMs,
  };
}

export function writeProxySettings(settings: ProxySettings): void {
  const validated = validateProxySettings(settings);
  const path = proxySettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(validated, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

export function maskProxyUrl(value: string): string {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
    if (url.username || url.password) {
      url.username = "redacted";
      url.password = "redacted";
    }
    return url.toString();
  } catch {
    return "Invalid proxy URL";
  }
}
