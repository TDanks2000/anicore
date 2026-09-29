import { timingSafeEqual } from "node:crypto";

type Headers = Record<string, string | undefined>;

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function extractAdminToken(headers: Headers): string | null {
  const authorization = headers.authorization;
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("bearer ".length).trim() || null;
  }
  return headers["x-anicore-admin-token"]?.trim() || null;
}

function isUnderPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Whether a request needs the admin token.
 *
 * Every write needs it, and so does every route under `/admin`, including
 * reads. `/sync-monitor` is exempt because it has its own access code.
 */
export function requiresAdmin(method: string, pathname: string): boolean {
  if (isUnderPrefix(pathname, "/sync-monitor")) return false;
  if (isUnderPrefix(pathname, "/admin")) return method.toUpperCase() !== "OPTIONS";
  return WRITE_METHODS.has(method.toUpperCase());
}

export type AdminAuthorization = { ok: true } | { ok: false; status: 401 | 503; error: string };

export function authorizeAdminRequest(input: {
  method: string;
  pathname: string;
  headers: Headers;
}): AdminAuthorization {
  if (!requiresAdmin(input.method, input.pathname)) return { ok: true };

  const configuredToken = process.env.ANICORE_ADMIN_TOKEN?.trim();
  if (!configuredToken) {
    return {
      ok: false,
      status: 503,
      error: "Admin routes are disabled until ANICORE_ADMIN_TOKEN is configured",
    };
  }

  const candidate = extractAdminToken(input.headers);
  if (!candidate || !secureEqual(candidate, configuredToken)) {
    return { ok: false, status: 401, error: "Invalid admin token" };
  }

  return { ok: true };
}
