import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";

const PROXY_ENV_KEYS = [
	"ANICORE_PROXY_URL",
	"HTTPS_PROXY",
	"https_proxy",
	"HTTP_PROXY",
	"http_proxy",
] as const;

const FREE_PROXY_LIST_URL =
	"https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=elite,anonymous";
const DEFAULT_FREE_PROXY_MAX_ATTEMPTS = 25;
const DEFAULT_PROXY_ATTEMPT_TIMEOUT_MS = 15_000;
const FREE_PROXY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_DIR = "data/cache";
// Untested proxy queue — proxies are removed from here as they are tested.
const PROXY_CACHE_FILE = `${CACHE_DIR}/proxies.txt`;
// Touched on each successful download; its mtime tracks the 24h re-download TTL
// independently of proxies.txt rewrites that happen during testing.
const PROXY_CACHE_TS_FILE = `${CACHE_DIR}/proxies_ts`;
const WORKING_PROXY_FILE = `${CACHE_DIR}/working_proxies.txt`;
const DEAD_PROXY_FILE = `${CACHE_DIR}/dead_proxies.txt`;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type BunProxyFetchInit = FetchInit & { proxy?: string };

let installed = false;
let freeProxyList: string[] | null = null;
let freeProxyListLoadedAt = 0;
let workingProxyList: string[] | null = null;
let deadProxySet: Set<string> | null = null;
let freeProxyIndex = 0;

function envEnabled(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function readConfiguredProxy(): string | null {
	for (const key of PROXY_ENV_KEYS) {
		const value = process.env[key]?.trim();
		if (value) return value;
	}

	return null;
}

function normalizeProxyUrl(value: string): string {
	if (/^https?:\/\//i.test(value)) return value;
	return `http://${value}`;
}

function ensureCacheDir(): void {
	mkdirSync(CACHE_DIR, { recursive: true });
}

function readProxyFile(path: string): string[] {
	if (!existsSync(path)) return [];

	return readFileSync(path, "utf-8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map(normalizeProxyUrl);
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function parseProxyList(text: string): string[] {
	return unique(
		text
			.split(/\r?\n/)
			.map((line) => line.trim())
			// Accept both raw ip:port and already-normalized http(s)://ip:port
			.filter(
				(line) =>
					/^\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}$/.test(line) ||
					/^https?:\/\/\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}$/.test(line),
			)
			.map(normalizeProxyUrl),
	);
}

function loadWorkingProxyList(): string[] {
	workingProxyList ??= unique(readProxyFile(WORKING_PROXY_FILE));
	return workingProxyList;
}

function loadDeadProxySet(): Set<string> {
	deadProxySet ??= new Set(readProxyFile(DEAD_PROXY_FILE));
	return deadProxySet;
}

function appendProxyIfMissing(path: string, proxy: string, values: string[] | Set<string>): void {
	if (values instanceof Set ? values.has(proxy) : values.includes(proxy)) return;

	ensureCacheDir();
	appendFileSync(path, `${proxy}\n`);

	if (values instanceof Set) values.add(proxy);
	else values.push(proxy);
}

function markWorkingProxy(proxy: string): void {
	appendProxyIfMissing(WORKING_PROXY_FILE, proxy, loadWorkingProxyList());
}

function markDeadProxy(proxy: string): void {
	appendProxyIfMissing(DEAD_PROXY_FILE, proxy, loadDeadProxySet());
}

function removeProxyFromUntestedList(proxy: string): void {
	if (!freeProxyList) return;
	const idx = freeProxyList.indexOf(proxy);
	if (idx === -1) return;
	freeProxyList.splice(idx, 1);
	try {
		ensureCacheDir();
		writeFileSync(
			PROXY_CACHE_FILE,
			freeProxyList.length ? `${freeProxyList.join("\n")}\n` : "",
		);
	} catch { /* ignore disk errors */ }
}

function freeProxyMaxAttempts(): number {
	const configured = Number(process.env.ANICORE_FREE_PROXY_MAX_ATTEMPTS);
	if (Number.isFinite(configured) && configured > 0) {
		return Math.floor(configured);
	}

	return DEFAULT_FREE_PROXY_MAX_ATTEMPTS;
}

function proxyAttemptTimeoutMs(): number {
	const configured = Number(process.env.ANICORE_PROXY_ATTEMPT_TIMEOUT_MS);
	if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
	return DEFAULT_PROXY_ATTEMPT_TIMEOUT_MS;
}

function shouldBypassProxy(input: FetchInput): boolean {
	const noProxy = process.env.NO_PROXY ?? process.env.no_proxy;
	if (!noProxy) return false;

	const target =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url;
	let hostname: string;
	try {
		hostname = new URL(target).hostname.toLowerCase();
	} catch {
		return false;
	}

	return noProxy
		.split(",")
		.map((part) => part.trim().toLowerCase())
		.filter(Boolean)
		.some((rule) => {
			if (rule === "*") return true;
			if (rule.startsWith(".")) return hostname.endsWith(rule);
			return hostname === rule || hostname.endsWith(`.${rule}`);
		});
}

async function loadFreeProxyList(rawFetch: typeof fetch): Promise<string[]> {
	if (freeProxyList && Date.now() - freeProxyListLoadedAt < FREE_PROXY_CACHE_TTL_MS) {
		return freeProxyList;
	}

	freeProxyList = null;

	// Use the timestamp file mtime to track when the list was last downloaded.
	// proxies.txt is rewritten frequently (proxy removals), so its mtime is unreliable.
	const cacheIsFresh =
		existsSync(PROXY_CACHE_TS_FILE) &&
		Date.now() - statSync(PROXY_CACHE_TS_FILE).mtimeMs < FREE_PROXY_CACHE_TTL_MS;

	if (!cacheIsFresh) {
		try {
			const response = await rawFetch(FREE_PROXY_LIST_URL, {
				headers: { Accept: "text/plain" },
				signal: AbortSignal.timeout(10_000),
			});

			if (!response.ok) {
				throw new Error(
					`Proxy list request failed: ${response.status} ${response.statusText}`,
				);
			}

			// Only keep proxies that haven't been classified yet.
			const downloaded = parseProxyList(await response.text());
			const knownDead = loadDeadProxySet();
			const knownWorking = new Set(loadWorkingProxyList());
			const untested = downloaded.filter((p) => !knownDead.has(p) && !knownWorking.has(p));

			ensureCacheDir();
			writeFileSync(PROXY_CACHE_FILE, untested.length ? `${untested.join("\n")}\n` : "");
			writeFileSync(PROXY_CACHE_TS_FILE, ""); // touch to record download time
		} catch {
			if (!existsSync(PROXY_CACHE_FILE)) throw new Error("No proxy cache available");
		}
	}

	freeProxyList = parseProxyList(readFileSync(PROXY_CACHE_FILE, "utf-8"));
	freeProxyListLoadedAt = Date.now();
	freeProxyIndex = 0;

	return freeProxyList;
}

function nextFreeProxy(proxies: string[]): string {
	const proxy = proxies[freeProxyIndex % proxies.length]!;
	freeProxyIndex++;
	return proxy;
}

async function fetchWithFreeProxyFallback(
	rawFetch: typeof fetch,
	input: FetchInput,
	init: FetchInit | undefined,
): Promise<Response> {
	let proxies: string[];
	let untestedSet: Set<string>;
	try {
		const knownDead = loadDeadProxySet();
		const knownWorking = loadWorkingProxyList().filter((proxy) => !knownDead.has(proxy));
		const freshProxies = (await loadFreeProxyList(rawFetch)).filter(
			(proxy) => !knownDead.has(proxy),
		);
		proxies = unique([...knownWorking, ...freshProxies]);
		untestedSet = new Set(freshProxies);
	} catch {
		return rawFetch(input, init);
	}

	if (!proxies.length) return rawFetch(input, init);

	const callerSignal = init?.signal;
	const timeoutMs = proxyAttemptTimeoutMs();
	const attempts = Math.min(proxies.length, freeProxyMaxAttempts());

	for (let attempt = 0; attempt < attempts; attempt++) {
		const proxy = nextFreeProxy(proxies);
		const isUntested = untestedSet.has(proxy);

		// Cap each attempt independently so a slow proxy can't exhaust the caller's signal.
		const attemptSignal = callerSignal
			? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)])
			: AbortSignal.timeout(timeoutMs);

		try {
			const response = await rawFetch(input, {
				...(init ?? {}),
				signal: attemptSignal,
				proxy,
			} as BunProxyFetchInit);

			// 407 means the proxy requires authentication — it's unusable as a free proxy.
			if (response.status === 407) {
				if (isUntested) removeProxyFromUntestedList(proxy);
				try { markDeadProxy(proxy); } catch { /* ignore disk errors */ }
				continue;
			}

			if (isUntested) removeProxyFromUntestedList(proxy);
			try { markWorkingProxy(proxy); } catch { /* ignore disk errors */ }
			return response;
		} catch (err) {
			// Caller intentionally cancelled — don't retry further.
			if (callerSignal?.aborted) throw err;
			if (isUntested) removeProxyFromUntestedList(proxy);
			try { markDeadProxy(proxy); } catch { /* ignore disk errors */ }
		}
	}

	return rawFetch(input, init);
}

export function installProxyFetch(): void {
	if (installed) return;
	installed = true;

	const rawFetch = globalThis.fetch.bind(globalThis);

	globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
		if (shouldBypassProxy(input)) {
			return rawFetch(input, init);
		}

		const configuredProxy = readConfiguredProxy();
		if (configuredProxy) {
			try {
				return await rawFetch(input, {
					...(init ?? {}),
					proxy: normalizeProxyUrl(configuredProxy),
				} as BunProxyFetchInit);
			} catch (err) {
				// If the caller's signal fired during the proxy attempt, propagate rather than
				// retrying with an already-aborted signal against the direct path.
				if (init?.signal?.aborted) throw err;
				return rawFetch(input, init);
			}
		}

		if (envEnabled(process.env.ANICORE_USE_FREE_PROXY)) {
			return fetchWithFreeProxyFallback(rawFetch, input, init);
		}

		return rawFetch(input, init);
	}) as typeof fetch;
}
