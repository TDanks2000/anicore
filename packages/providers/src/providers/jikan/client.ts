import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatHttpError } from "../../lib/http";
import { log } from "../../lib/logger";
import { waitForProvider } from "../../lib/provider-wait";

const BASE = "https://api.jikan.moe/v4";
const CACHE_DIR = fileURLToPath(
  new URL("../../../../../apps/api/data/cache/jikan", import.meta.url),
);
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const inFlight = new Map<string, Promise<JikanCharacter[] | null>>();
let requestQueue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;
let consecutiveFailures = 0;
let disabledUntil = 0;
const BASE_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
/** Thrown without a request while Jikan is cooling down; the outage is logged once on opening. */
export class JikanCircuitOpenError extends Error {}

export interface JikanCharacter {
  character: { mal_id: number; name: string };
  role: string;
  voice_actors: Array<{ language: string; person: { mal_id: number; name: string } }>;
}

export function validateCharacters(value: unknown): JikanCharacter[] {
  if (!Array.isArray(value)) throw new Error("Invalid Jikan character payload");
  return value.map((row: JikanCharacter) => {
    if (
      !row ||
      !Number.isInteger(row.character?.mal_id) ||
      row.character.mal_id <= 0 ||
      typeof row.character.name !== "string" ||
      typeof row.role !== "string" ||
      !Array.isArray(row.voice_actors)
    )
      throw new Error("Invalid Jikan character identity");
    const voice_actors = row.voice_actors.map((actor) => {
      if (
        !actor ||
        typeof actor.language !== "string" ||
        !Number.isInteger(actor.person?.mal_id) ||
        actor.person.mal_id <= 0 ||
        typeof actor.person.name !== "string"
      )
        throw new Error("Invalid Jikan voice credit");
      return {
        language: actor.language,
        person: { mal_id: actor.person.mal_id, name: actor.person.name },
      };
    });
    return {
      character: { mal_id: row.character.mal_id, name: row.character.name },
      role: row.role,
      voice_actors,
    };
  });
}

async function limitedFetch(url: string): Promise<Response> {
  const operation = requestQueue.then(async () => {
    // Jikan allows 60/minute and 3/second. Serialise even concurrent imports.
    await waitForProvider(Math.max(0, 1100 - (Date.now() - lastRequestAt)));
    lastRequestAt = Date.now();
    return fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  });
  requestQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

async function loadCharacters(id: string): Promise<JikanCharacter[] | null> {
  const path = join(CACHE_DIR, `${id}.json`);
  try {
    const cached = JSON.parse(await readFile(path, "utf8"));
    if (
      cached.version === 1 &&
      cached.malId === id &&
      Number.isFinite(cached.checkedAt) &&
      cached.checkedAt <= Date.now() &&
      Date.now() - cached.checkedAt < CACHE_TTL_MS
    )
      return validateCharacters(cached.data);
  } catch {
    // A missing, stale or corrupt cache is retried from the source.
  }
  if (Date.now() < disabledUntil)
    throw new JikanCircuitOpenError(
      "Jikan is temporarily unavailable; using the other language providers during its cooldown",
    );
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await limitedFetch(`${BASE}/anime/${id}/characters`);
    if (response.status === 404) return null;
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      const header = response.headers.get("retry-after");
      const numeric = header === null ? NaN : Number(header);
      const delay = Number.isFinite(numeric)
        ? numeric * 1000
        : header
          ? Date.parse(header) - Date.now()
          : 0;
      await waitForProvider(
        Math.max(1100 * 2 ** attempt, Math.min(30000, Number.isFinite(delay) ? delay : 0)),
      );
      continue;
    }
    if (!response.ok) throw new Error(await formatHttpError("Jikan characters", response));
    const body = (await response.json()) as { data?: unknown };
    const data = validateCharacters(body.data);
    // Cache failure must not discard successfully fetched evidence.
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, malId: id, checkedAt: Date.now(), data }),
      );
      await rename(temporary, path);
    } catch {
      await unlink(temporary).catch(() => undefined);
    }
    return data;
  }
  throw new Error("Jikan retry limit exceeded");
}

export function fetchCharacters(id: string): Promise<JikanCharacter[] | null> {
  if (!/^[1-9]\d*$/.test(id)) throw new Error("Invalid MAL id for Jikan");
  const existing = inFlight.get(id);
  if (existing) return existing;
  const pending = loadCharacters(id)
    .then(
      (data) => {
        consecutiveFailures = 0;
        disabledUntil = 0;
        return data;
      },
      (error) => {
        if (!(error instanceof JikanCircuitOpenError)) {
          consecutiveFailures++;
          if (consecutiveFailures >= 3) {
            // Each failed probe after a cooldown doubles the next one, so a long
            // outage stops costing a request timeout every minute.
            const cooldown = Math.min(
              MAX_COOLDOWN_MS,
              BASE_COOLDOWN_MS * 2 ** (consecutiveFailures - 3),
            );
            disabledUntil = Date.now() + cooldown;
            log.warn(
              `Jikan failed ${consecutiveFailures} times in a row; skipping it for ${Math.round(cooldown / 1000)}s`,
            );
          }
        }
        throw error;
      },
    )
    .finally(() => inFlight.delete(id));
  inFlight.set(id, pending);
  return pending;
}
