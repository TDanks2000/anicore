/**
 * The extended SQLite result code of a database error (e.g.
 * `SQLITE_CONSTRAINT_UNIQUE`), looking through the wrappers drizzle adds.
 * Matching on codes rather than message text keeps the classification stable
 * across driver versions.
 */
export function sqliteErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === "object") {
      for (const key of ["extendedCode", "code"] as const) {
        const value = key in current ? (current as Record<string, unknown>)[key] : undefined;
        if (typeof value === "string" && value.startsWith("SQLITE_")) return value;
      }
    }
    current = current instanceof Error ? current.cause : null;
  }
  return null;
}

export const isUniqueViolation = (error: unknown) => {
  const code = sqliteErrorCode(error);
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY";
};
export const isForeignKeyViolation = (error: unknown) =>
  sqliteErrorCode(error) === "SQLITE_CONSTRAINT_FOREIGNKEY";
/** Another connection holds the write lock; the statement did not run. */
export const isBusyError = (error: unknown) => {
  const code = sqliteErrorCode(error);
  return code?.startsWith("SQLITE_BUSY") === true || code?.startsWith("SQLITE_LOCKED") === true;
};
