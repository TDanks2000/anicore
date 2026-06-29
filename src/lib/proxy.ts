const PROXY_ENV_KEYS = [
	"ANICORE_PROXY_URL",
	"HTTPS_PROXY",
	"https_proxy",
	"HTTP_PROXY",
	"http_proxy",
] as const;

const FREE_PROXY_LIST_URL =
	"https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=elite,anonymous";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
type BunProxyFetchInit = FetchInit & { proxy?: string };

let installed = false;
let freeProxyList: string[] | null = null;
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

	const response = await rawFetch(FREE_PROXY_LIST_URL, {
		headers: { Accept: "text/plain" },
		signal: AbortSignal.timeout(10_000),
	});

	if (!response.ok) {
		throw new Error(
			`Proxy list request failed: ${response.status} ${response.statusText}`,
		);
	}

	const text = await response.text();
	freeProxyList = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}$/.test(line))
		.map(normalizeProxyUrl);

	return freeProxyList;
}

async function selectProxy(rawFetch: typeof fetch): Promise<string | null> {
	const configured = readConfiguredProxy();
	if (configured) return normalizeProxyUrl(configured);

	if (!envEnabled(process.env.ANICORE_USE_FREE_PROXY)) return null;

	const proxies = await loadFreeProxyList(rawFetch);
	if (!proxies.length) return null;

	const proxy = proxies[freeProxyIndex % proxies.length]!;
	freeProxyIndex++;
	return proxy;
}

export function installProxyFetch(): void {
	if (installed) return;
	installed = true;

	const rawFetch = globalThis.fetch.bind(globalThis);

	globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
		if (shouldBypassProxy(input)) {
			return rawFetch(input, init);
		}

		const proxy = await selectProxy(rawFetch);
		if (!proxy) return rawFetch(input, init);

		return rawFetch(input, { ...(init ?? {}), proxy } as BunProxyFetchInit);
	}) as typeof fetch;
}
