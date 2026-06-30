import { describe, expect, test } from "bun:test";

import { getDatabaseConfig } from "./db-config";

describe("getDatabaseConfig", () => {
  test("requires DATABASE_URL", () => {
    expect(() => getDatabaseConfig({})).toThrow(
      "DATABASE_URL is required to connect to Postgres.",
    );
  });

  test("defaults to ssl require", () => {
    expect(getDatabaseConfig({ DATABASE_URL: "postgres://example" })).toEqual({
      url: "postgres://example",
      ssl: "require",
    });
  });

  test("allows ssl to be disabled explicitly", () => {
    expect(
      getDatabaseConfig({
        DATABASE_URL: "postgres://example",
        ANICORE_DATABASE_SSL: "disable",
      }),
    ).toEqual({ url: "postgres://example", ssl: false });
  });
});
