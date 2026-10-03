import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { DEFAULT_DATABASE_PATH, getDatabaseConfig } from "./db-config";

describe("getDatabaseConfig", () => {
  test("defaults to the API data directory", () => {
    expect(getDatabaseConfig({})).toEqual({
      url: `file:${DEFAULT_DATABASE_PATH}`,
      path: DEFAULT_DATABASE_PATH,
    });
    expect(DEFAULT_DATABASE_PATH.replaceAll("\\", "/").endsWith("/apps/api/data/anicore.db")).toBe(
      true,
    );
  });

  test("accepts plain paths and file: URLs, resolving relative ones", () => {
    expect(getDatabaseConfig({ DATABASE_URL: "/tmp/a.db" })).toEqual({
      url: "file:/tmp/a.db",
      path: "/tmp/a.db",
    });
    const relative = resolve(process.cwd(), "data/b.db");
    expect(getDatabaseConfig({ DATABASE_URL: "file:data/b.db" })).toEqual({
      url: `file:${relative}`,
      path: relative,
    });
  });

  test("rejects in-memory databases", () => {
    expect(() => getDatabaseConfig({ DATABASE_URL: ":memory:" })).toThrow("not supported");
  });

  test("rejects a leftover Postgres URL", () => {
    expect(() => getDatabaseConfig({ DATABASE_URL: "postgresql://u:p@host/db" })).toThrow(
      "local SQLite file",
    );
    expect(() => getDatabaseConfig({ DATABASE_URL: "mysql://host/db" })).toThrow(
      "Unsupported DATABASE_URL scheme",
    );
  });
});
