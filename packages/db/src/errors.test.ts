import { describe, expect, test } from "bun:test";

import { isBusyError, isForeignKeyViolation, isUniqueViolation, sqliteErrorCode } from "./errors";

function libsqlError(code: string, extendedCode: string): Error {
  return Object.assign(new Error(`${code}: constraint failed`), { code, extendedCode });
}

describe("sqliteErrorCode", () => {
  test("reads the extended result code from the error or its causes", () => {
    const unique = libsqlError("SQLITE_CONSTRAINT", "SQLITE_CONSTRAINT_UNIQUE");
    expect(sqliteErrorCode(unique)).toBe("SQLITE_CONSTRAINT_UNIQUE");
    expect(sqliteErrorCode(new Error("wrapped", { cause: unique }))).toBe(
      "SQLITE_CONSTRAINT_UNIQUE",
    );
    expect(isUniqueViolation(new Error("wrapped", { cause: unique }))).toBe(true);
    expect(isForeignKeyViolation(unique)).toBe(false);
    expect(
      isForeignKeyViolation(libsqlError("SQLITE_CONSTRAINT", "SQLITE_CONSTRAINT_FOREIGNKEY")),
    ).toBe(true);
    expect(isBusyError(libsqlError("SQLITE_BUSY", "SQLITE_BUSY"))).toBe(true);
  });

  test("ignores non-SQLite codes and plain values", () => {
    expect(sqliteErrorCode(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBeNull();
    expect(sqliteErrorCode(new Error("unique constraint"))).toBeNull();
    expect(sqliteErrorCode("SQLITE_CONSTRAINT_UNIQUE")).toBeNull();
    expect(sqliteErrorCode(null)).toBeNull();
  });
});
