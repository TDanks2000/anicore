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

export { isForeignKeyViolation, isUniqueViolation, sqliteErrorCode } from "@anicore/db/errors";
