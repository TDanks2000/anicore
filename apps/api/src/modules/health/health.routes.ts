import { db } from "@anicore/db";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";

export const healthRoutes = new Elysia({ prefix: "/health", detail: { tags: ["Health"] } })
  // Liveness: the process is up and serving requests.
  .get("/", () => ({ ok: true, name: "anicore" }))
  // Readiness: the database is reachable, so requests can actually be served.
  .get("/ready", async ({ set }) => {
    try {
      await db.execute(sql`select 1`);
      return { ok: true, database: "up" };
    } catch (error) {
      console.error("Readiness check failed", error);
      set.status = 503;
      return { ok: false, database: "down" };
    }
  });
