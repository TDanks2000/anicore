import { describe, expect, test } from "bun:test";

import { isForeignKeyViolation, isUniqueViolation, postgresErrorCode } from "./errors";

describe("postgresErrorCode", () => {
  test("reads the SQLSTATE from the error or its causes", () => {
    const pg = Object.assign(new Error("duplicate key"), { code: "23505" });
    expect(postgresErrorCode(pg)).toBe("23505");
    expect(postgresErrorCode(new Error("wrapped", { cause: pg }))).toBe("23505");
    expect(isUniqueViolation(new Error("wrapped", { cause: pg }))).toBe(true);
    expect(isForeignKeyViolation(pg)).toBe(false);
  });

  test("ignores non-SQLSTATE codes and plain values", () => {
    expect(postgresErrorCode(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBeNull();
    expect(postgresErrorCode(new Error("unique constraint"))).toBeNull();
    expect(postgresErrorCode("23505")).toBeNull();
    expect(postgresErrorCode(null)).toBeNull();
  });
});
