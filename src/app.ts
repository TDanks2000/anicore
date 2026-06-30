import { Elysia } from "elysia";

import { animeRoutes } from "./modules/anime/anime.routes";
import { episodeRoutes } from "./modules/episodes/episodes.routes";
import { healthRoutes } from "./modules/health/health.routes";
import { mappingRoutes } from "./modules/mappings/mappings.routes";
import { syncMonitorRoutes } from "./modules/sync-monitor/sync-monitor.routes";

export const app = new Elysia()
  .use(healthRoutes)
  .use(syncMonitorRoutes)
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
