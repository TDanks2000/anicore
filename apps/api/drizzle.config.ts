import { defineConfig } from "drizzle-kit";

// Migrations live beside the schema in packages/db, which applies them
// automatically whenever the database is opened.
const databasePath = process.env.DATABASE_URL?.trim().replace(/^file:/, "") || "./data/anicore.db";

export default defineConfig({
  schema: ["../../packages/db/src/schema.ts", "../../packages/db/src/provider-mapping-schema.ts"],
  out: "../../packages/db/drizzle",
  dialect: "turso",
  dbCredentials: {
    url: `file:${databasePath}`,
  },
});
