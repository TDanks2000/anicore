import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendRotatingLog } from "./rotating-log";

/** Where CORS request lines are appended when ANICORE_CORS_LOG is unset. */
export const DEFAULT_CORS_LOG_PATH = fileURLToPath(
  new URL("../../data/logs/cors.log", import.meta.url),
);

type Env = Record<string, string | undefined>;

/** Resolves the CORS log file path; relative paths resolve against the working directory. */
export function resolveCorsLogPath(env: Env = process.env): string {
  const raw = env.ANICORE_CORS_LOG?.trim();
  if (!raw) return DEFAULT_CORS_LOG_PATH;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

/**
 * Appends one CORS line to the log file and also echoes it to stdout.
 * Logging must never crash the request, so failures fall back to stderr.
 */
export function logCors(line: string): void {
  const formatted = `${new Date().toISOString()} ${line}\n`;
  console.log(line);
  try {
    const target = resolveCorsLogPath();
    appendRotatingLog(target, formatted);
  } catch (error) {
    console.error("[cors] failed to write CORS log", error);
  }
}
