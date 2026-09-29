/**
 * An error whose message is safe to return to the client with its status.
 * Anything else that reaches the global error handler becomes a generic 500.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message: string) => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);

/**
 * The SQLSTATE of a Postgres error, looking through the wrappers drizzle adds.
 * Matching on codes rather than message text keeps the classification stable
 * across driver versions and locales.
 */
export function postgresErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === "object" && "code" in current && typeof current.code === "string") {
      if (/^[0-9A-Z]{5}$/.test(current.code)) return current.code;
    }
    current = current instanceof Error ? current.cause : null;
  }
  return null;
}

export const isUniqueViolation = (error: unknown) => postgresErrorCode(error) === "23505";
export const isForeignKeyViolation = (error: unknown) => postgresErrorCode(error) === "23503";
