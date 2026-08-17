import { timingSafeEqual } from "node:crypto";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function secureEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

function extractAdminToken(headers: Record<string, string | undefined>): string | null {
	const authorization = headers.authorization;
	if (authorization?.toLowerCase().startsWith("bearer ")) {
		return authorization.slice("bearer ".length).trim();
	}

	return headers["x-anicore-admin-token"]?.trim() || null;
}

export function isAdminAuthenticated(
	headers: Record<string, string | undefined>,
): boolean {
	const configuredToken = process.env.ANICORE_ADMIN_TOKEN?.trim();
	if (!configuredToken) return false;

	const candidate = extractAdminToken(headers);
	return Boolean(candidate && secureEqual(candidate, configuredToken));
}

export type AdminWriteAuthorization =
	| { ok: true }
	| { ok: false; status: 401 | 503; error: string };

export function authorizeAdminWrite(input: {
	method: string;
	pathname: string;
	headers: Record<string, string | undefined>;
}): AdminWriteAuthorization {
	const method = input.method.toUpperCase();
	if (!WRITE_METHODS.has(method)) return { ok: true };
	if (
		input.pathname === "/sync-monitor" ||
		input.pathname.startsWith("/sync-monitor/")
	) {
		return { ok: true };
	}

	const configuredToken = process.env.ANICORE_ADMIN_TOKEN?.trim();
	if (!configuredToken) {
		return {
			ok: false,
			status: 503,
			error: "API writes are disabled until ANICORE_ADMIN_TOKEN is configured",
		};
	}

	if (!isAdminAuthenticated(input.headers)) {
		return { ok: false, status: 401, error: "Invalid admin token" };
	}

	return { ok: true };
}
