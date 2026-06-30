export type DatabaseSslMode = "require" | "disable";

export interface DatabaseConfig {
  url: string;
  ssl: "require" | false;
}

type Env = Record<string, string | undefined>;

function readSslMode(env: Env): DatabaseSslMode {
  const raw = env.ANICORE_DATABASE_SSL?.trim().toLowerCase();
  if (!raw || raw === "require" || raw === "true" || raw === "1") {
    return "require";
  }
  if (raw === "disable" || raw === "false" || raw === "0") {
    return "disable";
  }

  throw new Error(
    "Invalid ANICORE_DATABASE_SSL. Use 'require' or 'disable'.",
  );
}

export function getDatabaseConfig(env: Env = process.env): DatabaseConfig {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL is required to connect to Postgres.");
  }

  const sslMode = readSslMode(env);

  return {
    url,
    ssl: sslMode === "require" ? "require" : false,
  };
}
