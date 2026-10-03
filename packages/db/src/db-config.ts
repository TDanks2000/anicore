import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DatabaseConfig {
  /** libsql connection URL, always `file:<absolute path>`. */
  url: string;
  /** Absolute path of the database file. */
  path: string;
}

type Env = Record<string, string | undefined>;

/** Where the database lives when DATABASE_URL is unset: next to the API's other local data. */
export const DEFAULT_DATABASE_PATH = fileURLToPath(
  new URL("../../../apps/api/data/anicore.db", import.meta.url),
);

/**
 * Resolves the local SQLite database location.
 *
 * DATABASE_URL is optional and accepts a plain path or a `file:` URL.
 * Relative paths resolve against the working directory. A
 * leftover Postgres URL is rejected loudly rather than silently ignored, so an
 * old `.env` cannot make AniCore write to a fresh, empty file without notice.
 */
export function getDatabaseConfig(env: Env = process.env): DatabaseConfig {
  const raw = env.DATABASE_URL?.trim();
  if (!raw) return fileConfig(DEFAULT_DATABASE_PATH);
  // libsql opens a fresh connection after every transaction, and each
  // connection to `:memory:` would see its own empty database.
  if (raw.includes(":memory:")) {
    throw new Error("In-memory databases are not supported; set DATABASE_URL to a file path.");
  }

  if (/^postgres(ql)?:\/\//i.test(raw)) {
    throw new Error(
      "DATABASE_URL points at Postgres, but AniCore now stores data in a local SQLite file. " +
        "Unset DATABASE_URL to use the default file, or set it to a file path.",
    );
  }

  if (raw.startsWith("file:")) {
    const path = raw.slice("file:".length);
    if (!path) throw new Error("DATABASE_URL `file:` URL is missing a path.");
    return fileConfig(path);
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw new Error(`Unsupported DATABASE_URL scheme in "${raw}". Use a file path.`);
  }

  return fileConfig(raw);
}

function fileConfig(path: string): DatabaseConfig {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  return { url: `file:${absolute}`, path: absolute };
}
