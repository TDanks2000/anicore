import { Elysia } from "elysia";
import { cors } from "@elysia/cors";

import { authorizeAdminWrite } from "./lib/admin-auth";
import { enforceMappingWriteInvariants } from "./lib/mapping-write-invariants";
import { animeRoutes } from "./modules/anime/anime.routes";
import { episodeRoutes } from "./modules/episodes/episodes.routes";
import { healthRoutes } from "./modules/health/health.routes";
import { languageStatusRoutes } from "./modules/language-status/language-status.routes";
import { mappingRoutes } from "./modules/mappings/mappings.routes";
import { syncMonitorRoutes } from "./modules/sync-monitor/sync-monitor.routes";

export const app = new Elysia()
  .onError({ as: "global" }, ({ code, error, set }) => {
    if (code === "VALIDATION" || code === "PARSE") {
      set.status = 400;
      return { error: "Validation failed" };
    }

    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "Not found" };
    }

    console.error(error);
    set.status = 500;
    return { error: "Internal server error" };
  })
  .onBeforeHandle({ as: "global" }, ({ request, headers, set }) => {
    const auth = authorizeAdminWrite({
      method: request.method,
      pathname: new URL(request.url).pathname,
      headers,
    });
    if (auth.ok) return;

    set.status = auth.status;
    if (auth.status === 401) {
      set.headers["WWW-Authenticate"] = 'Bearer realm="AniCore Admin"';
    }
    return { error: auth.error };
  })
  .onBeforeHandle({ as: "global" }, async ({ request, body, set }) => {
    const result = await enforceMappingWriteInvariants({
      method: request.method,
      pathname: new URL(request.url).pathname,
      body,
    });
    if (result.ok) return;

    set.status = result.status;
    return { error: result.error };
  })
  .use(
    cors({
      origin: process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim())
        : ["http://localhost:5173", "http://localhost:4173"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Anicore-Admin-Token",
        "X-Sync-Monitor-Code",
      ],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: false,
      preflight: true,
    }),
  )
  .use(healthRoutes)
  .use(syncMonitorRoutes)
  .use(languageStatusRoutes)
  .use(animeRoutes)
  .use(episodeRoutes)
  .use(mappingRoutes);
