import { readFileSync } from "node:fs";
import { Elysia } from "elysia";

// Resolve against this module so docs work from both the repo and API working directories.
// PM2 loads the Bun entry point with require(), so its imports cannot use top-level await.
const overview = readFileSync(new URL("./llms.txt", import.meta.url), "utf8");
const integrationGuide = readFileSync(new URL("./llms-full.txt", import.meta.url), "utf8");

export const docsRoutes = new Elysia({ detail: { tags: ["Documentation"] } })
  .get(
    "/llms.txt",
    ({ set }) => {
      set.headers["Content-Type"] = "text/plain; charset=utf-8";
      return overview;
    },
    { detail: { summary: "Agent documentation index" } },
  )
  .get(
    "/llms-full.txt",
    ({ set }) => {
      set.headers["Content-Type"] = "text/plain; charset=utf-8";
      return integrationGuide;
    },
    { detail: { summary: "Agent API integration guide" } },
  );
