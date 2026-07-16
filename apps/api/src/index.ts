import { installProxyFetch } from "@anicore/providers/lib/proxy";
import { app } from "./app";

installProxyFetch();

function readPort(value: string | undefined): number {
	const port = Number(value ?? 3000);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("PORT must be an integer between 1 and 65535");
	}
	return port;
}

const port = readPort(process.env.PORT);
const hostname = process.env.HOST ?? "localhost";

app.listen({ hostname, port });

console.log(`AniCore API running at http://${hostname}:${port}`);
