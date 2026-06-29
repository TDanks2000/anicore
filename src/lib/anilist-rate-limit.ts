import { log } from "./logger";

// AniList public API: 90 req/min → 2 parallel reqs/ID → min 1333ms. 1500ms is safe.
export const ANILIST_RATE_MS = 1500;

export function isRateLimitError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return (
		msg.includes("429") ||
		msg.toLowerCase().includes("rate limit") ||
		msg.toLowerCase().includes("too many requests")
	);
}

export async function withAnilistRetry<T>(
	fn: () => Promise<T>,
	onRateLimit?: (err: unknown, attempt: number) => void,
): Promise<T> {
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			return await fn();
		} catch (err) {
			if (!isRateLimitError(err) || attempt === 3) throw err;
			onRateLimit?.(err, attempt + 1);
			const wait = 60_000 * (attempt + 1);
			log.warn(
				`Rate limited — waiting ${wait / 1000}s before retry ${attempt + 1}/3…`,
			);
			await Bun.sleep(wait);
		}
	}
	throw new Error("unreachable");
}
