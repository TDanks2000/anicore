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

export function isTransientAnilistError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return (
		/\b(?:status\s*)?5\d{2}\b/i.test(message) ||
		/timeout|timed out|connection reset|network error|fetch failed/i.test(message)
	);
}

export async function withAnilistRetry<T>(
	fn: () => Promise<T>,
	onRateLimit?: (err: unknown, attempt: number) => void,
	sleep: (milliseconds: number) => Promise<unknown> = Bun.sleep,
): Promise<T> {
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			return await fn();
		} catch (err) {
			const isRateLimit = isRateLimitError(err);
			const isTransient = isTransientAnilistError(err);
			if ((!isRateLimit && !isTransient) || attempt === 3) throw err;

			const wait = isRateLimit
				? 60_000 * (attempt + 1)
				: 1_000 * 2 ** attempt;
			if (isRateLimit) onRateLimit?.(err, attempt + 1);
			log.warn(
				isRateLimit
					? `Rate limited — waiting ${wait / 1000}s before retry ${attempt + 1}/3…`
					: `AniList request failed temporarily — retrying in ${wait / 1000}s (${attempt + 1}/3)…`,
			);
			await sleep(wait);
		}
	}
	throw new Error("unreachable");
}
