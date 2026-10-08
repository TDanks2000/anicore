import { Elysia } from "elysia";

// Resolve against this module so docs work from both the repo and API working directories.
const overview = await Bun.file(new URL("./llms.txt", import.meta.url)).text();
const integrationGuide = await Bun.file(new URL("./llms-full.txt", import.meta.url)).text();

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
