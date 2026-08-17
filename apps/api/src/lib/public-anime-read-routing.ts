import { parseLimit } from "./params";

export type PotentiallyMutatingAnimeRead =
	| { kind: "search"; search: string; limit: number }
	| { kind: "anilist-mapping"; providerId: string };

export function classifyPotentiallyMutatingAnimeRead(
	method: string,
	requestUrl: string,
): PotentiallyMutatingAnimeRead | null {
	if (method.toUpperCase() !== "GET") return null;

	const url = new URL(requestUrl);
	if (url.pathname === "/anime" || url.pathname === "/anime/") {
		const search = url.searchParams.get("q")?.trim();
		if (!search) return null;
		return {
			kind: "search",
			search,
			limit: parseLimit(url.searchParams.get("limit") ?? undefined),
		};
	}

	const match = url.pathname.match(/^\/anime\/by\/anilist\/([^/]+)$/);
	if (!match?.[1]) return null;
	return { kind: "anilist-mapping", providerId: match[1] };
}
