import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "../../packages/db/src/schema.ts",
    "../../packages/db/src/provider-mapping-schema.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
