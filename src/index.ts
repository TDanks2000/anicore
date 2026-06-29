import { installProxyFetch } from "./lib/proxy";
import { app } from "./app";

installProxyFetch();

const port = Number(process.env.PORT ?? 3000);

app.listen(port);

console.log(`AniCore API running at http://localhost:${port}`);
