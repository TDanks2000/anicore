import { cors } from "@elysia/cors";
import { openapi } from "@elysia/openapi";
import { Elysia } from "elysia";

import { authorizeAdminRequest } from "./lib/admin-auth";
import { logCors } from "./lib/cors-log";
import { HttpError, isForeignKeyViolation, isUniqueViolation } from "./lib/errors";
import { animeRoutes } from "./modules/anime/anime.routes";
import { episodeRoutes } from "./modules/episodes/episodes.routes";
import { healthRoutes } from "./modules/health/health.routes";
import { languageStatusRoutes } from "./modules/language-status/language-status.routes";
import { mappingRoutes } from "./modules/mappings/mappings.routes";
import { syncMonitorRoutes } from "./modules/sync-monitor/sync-monitor.routes";

const DEFAULT_CORS_ORIGINS = ["http://localhost:5173", "http://localhost:4173"];

function corsOrigins(): string[] {
  const configured = process.env.CORS_ORIGIN?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return configured?.length ? configured : DEFAULT_CORS_ORIGINS;
}

interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Elysia coerces numeric params through a union of "numeric string" and
 * "integer", so its summaries read "should be one of: 'integer', 'integer'".
 * Collapse repeated alternatives into a readable sentence.
 */
export function readableValidationMessage(message: string): string {
  const match = message.match(/^(.*) should be one of: (.+)$/);
  if (!match) return message;
  const options = [...new Set(match[2]!.split(/,\s*/))];
  return options.length === 1
    ? `${match[1]} should be ${options[0]!.replace(/'/g, "")}`
    : `${match[1]} should be one of: ${options.join(", ")}`;
}

/** Field paths and messages only: echoing values could leak submitted secrets. */
function validationIssues(error: unknown): ValidationIssue[] {
  const all = (error as { all?: Array<{ path?: string; summary?: string; message?: string }> }).all;
  if (!Array.isArray(all)) return [];
  return all.map((issue) => ({
    path: issue.path || "/",
    message: readableValidationMessage(issue.summary ?? issue.message ?? "Invalid value"),
  }));
}

export const app = new Elysia()
  // Log blocked cross-origin requests only, so misconfigured origins are visible
  // without drowning the log in normal traffic.
  .onRequest(({ request }) => {
    const origin = request.headers.get("origin");
    if (!origin) return;
    const allowed = corsOrigins();
    if (allowed.includes(origin)) return;
    const url = new URL(request.url);
    const isPreflight = request.method === "OPTIONS";
    logCors(
      `[cors] BLOCKED ${isPreflight ? "preflight " : ""}${request.method} ${url.pathname} ` +
        `origin=${origin} allowed=[${allowed.join(", ")}]`,
    );
  })
  // CORS must run first so that early rejections still carry CORS headers.
  .use(
    cors({
      origin: corsOrigins(),
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Anicore-Admin-Token",
        "X-Sync-Monitor-Code",
      ],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      // The dashboard reads list totals from this header, so browsers must be
      // allowed to expose it on cross-origin reads.
      exposeHeaders: ["X-Total-Count"],
      credentials: false,
      preflight: true,
    }),
  )
  // Authorize before the body is parsed or validated, so unauthenticated
  // callers learn nothing about the shape of admin routes.
  .onRequest(({ request, set }) => {
    const auth = authorizeAdminRequest({
      method: request.method,
      pathname: new URL(request.url).pathname,
      headers: {
        authorization: request.headers.get("authorization") ?? undefined,
        "x-anicore-admin-token": request.headers.get("x-anicore-admin-token") ?? undefined,
      },
    });
    if (auth.ok) return;

    set.status = auth.status;
    if (auth.status === 401) set.headers["WWW-Authenticate"] = 'Bearer realm="AniCore Admin"';
    return { error: auth.error };
  })
  .onError({ as: "global" }, ({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return { error: error.message };
    }

    switch (code) {
      case "VALIDATION":
        set.status = 400;
        return { error: "Validation failed", issues: validationIssues(error) };
      case "PARSE":
        set.status = 400;
        return { error: "Malformed request body" };
      case "NOT_FOUND":
        set.status = 404;
        return { error: "Not found" };
    }

    if (isUniqueViolation(error)) {
      set.status = 409;
      return { error: "Conflicts with an existing record" };
    }
    if (isForeignKeyViolation(error)) {
      set.status = 409;
      return { error: "A referenced record does not exist" };
    }

    console.error(error);
    set.status = 500;
    return { error: "Internal server error" };
  })
  .use(
    openapi({
      path: "/docs",
      exclude: { paths: [/^\/docs/] },
      documentation: {
        info: {
          title: "AniCore API",
          version: "0.1.0",
          description:
            "Unified anime metadata: anime, episodes, cross-provider mappings and dub/sub availability. " +
            "Reads are public. Writes and every /admin route need the admin token; /sync-monitor uses its own access code.",
        },
        components: {
          securitySchemes: {
            adminToken: { type: "http", scheme: "bearer", description: "ANICORE_ADMIN_TOKEN" },
            monitorCode: {
              type: "http",
              scheme: "bearer",
              description: "Sync monitor access code",
            },
          },
        },
      },
    }),
  )
  .use(healthRoutes)
  .use(syncMonitorRoutes)
  .use(languageStatusRoutes)
  .use(animeRoutes)
  .use(episodeRoutes)
  .use(mappingRoutes);

export type App = typeof app;
