import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
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
const FREE_PROXY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_DIR = "data/cache";
const PROXY_CACHE_FILE = `${CACHE_DIR}/proxies.txt`;
const WORKING_PROXY_FILE = `${CACHE_DIR}/working_proxies.txt`;
const DEAD_PROXY_FILE = `${CACHE_DIR}/dead_proxies.txt`;

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type BunProxyFetchInit = FetchInit & { proxy?: string };

let installed = false;
let freeProxyList: string[] | null = null;
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
			.filter((line) => /^\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}$/.test(line))
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

function freeProxyMaxAttempts(): number {
	const configured = Number(process.env.ANICORE_FREE_PROXY_MAX_ATTEMPTS);
	if (Number.isFinite(configured) && configured > 0) {
		return Math.floor(configured);
	}

	return DEFAULT_FREE_PROXY_MAX_ATTEMPTS;
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
	if (freeProxyList) return freeProxyList;

	const cacheIsFresh =
		existsSync(PROXY_CACHE_FILE) &&
		Date.now() - statSync(PROXY_CACHE_FILE).mtimeMs < FREE_PROXY_CACHE_TTL_MS;

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

			ensureCacheDir();
			await Bun.write(PROXY_CACHE_FILE, await response.text());
		} catch {
			if (!existsSync(PROXY_CACHE_FILE)) throw new Error("No proxy cache available");
		}
	}

	freeProxyList = parseProxyList(readFileSync(PROXY_CACHE_FILE, "utf-8"));

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
	try {
		const knownDead = loadDeadProxySet();
		const knownWorking = loadWorkingProxyList().filter((proxy) => !knownDead.has(proxy));
		const freshProxies = (await loadFreeProxyList(rawFetch)).filter(
			(proxy) => !knownDead.has(proxy),
		);
		proxies = unique([...knownWorking, ...freshProxies]);
	} catch {
		return rawFetch(input, init);
	}

	if (!proxies.length) return rawFetch(input, init);

	const attempts = Math.min(proxies.length, freeProxyMaxAttempts());
	for (let attempt = 0; attempt < attempts; attempt++) {
		const proxy = nextFreeProxy(proxies);
		try {
			const response = await rawFetch(input, { ...(init ?? {}), proxy } as BunProxyFetchInit);
			markWorkingProxy(proxy);
			return response;
		} catch {
			markDeadProxy(proxy);
			continue;
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
			} catch {
				return rawFetch(input, init);
			}
		}

		if (envEnabled(process.env.ANICORE_USE_FREE_PROXY)) {
			return fetchWithFreeProxyFallback(rawFetch, input, init);
		}

		return rawFetch(input, init);
	}) as typeof fetch;
}
