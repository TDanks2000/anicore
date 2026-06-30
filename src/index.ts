import { installProxyFetch } from "./lib/proxy";
import { app } from "./app";

installProxyFetch();

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? process.env.HOSTNAME ?? "localhost";

app.listen({ hostname, port });

console.log(`AniCore API running at http://${hostname}:${port}`);
