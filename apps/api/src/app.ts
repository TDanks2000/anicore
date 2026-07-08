import { Elysia } from "elysia";
import { cors } from "@elysia/cors";

import { animeRoutes } from "./modules/anime/anime.routes";
import { episodeRoutes } from "./modules/episodes/episodes.routes";
import { healthRoutes } from "./modules/health/health.routes";
import { languageStatusRoutes } from "./modules/language-status/language-status.routes";
import { mappingRoutes } from "./modules/mappings/mappings.routes";
import { syncMonitorRoutes } from "./modules/sync-monitor/sync-monitor.routes";

export const app = new Elysia()
  .use(
    cors({
      origin: process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim())
        : true,
      allowedHeaders: ["Content-Type", "Authorization", "X-Sync-Monitor-Code"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      preflight: true,
    }),
  )
  .use(healthRoutes)
  .use(syncMonitorRoutes)
  .use(languageStatusRoutes)
  .use(animeRoutes)
  .use(episodeRoutes)
  .use(mappingRoutes)
  .onError(({ code, error, set }) => {
    console.error(error);

    if (code === "VALIDATION") {
      set.status = 400;

      return {
        error: "Validation failed",
        details: error.message,
      };
    }

    set.status = 500;

    return {
      error: "Internal server error",
    };
  });
