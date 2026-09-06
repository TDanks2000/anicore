AniCore is a unified anime metadata API for mapping anime, episodes, and dub/sub availability across sources like AniList, Kitsu, and streaming providers.

## Monorepo

AniCore uses Bun workspaces and Turborepo:

- `apps/api` - Elysia API, database scripts, provider sync runner
- `apps/web` - Vite + React + Tailwind v4 monitor dashboard
- `packages/db` - Drizzle schema, database connection, and DB validation helpers
- `packages/providers` - AniList/Kitsu/provider sync clients, mappers, and sync utilities
- `packages/sync-monitor` - shared sync monitor response types and browser client

Install dependencies from the repo root:

```sh
bun install
```

Useful root commands:

```sh
bun run dev:api
bun run dev:web
bun run dev
bun run start
bun run build
bun run typecheck
bun run test
```

Root commands force Turbo's stream UI so Windows shells avoid the interactive UI path that can fail with exit code 56.

`bun run dev` starts the API and Vite dashboard together for development. `bun run start` builds the workspaces, starts the API, enables the automatic sync scheduler, and serves the built dashboard from one command.

Put API secrets in `apps/api/.env`. The old root `.env` was copied locally to `apps/api/.env` during the migration if it existed.

### API write authentication

Read-only API routes remain public. All non-monitor `POST`, `PUT`, `PATCH`, and `DELETE` requests require `ANICORE_ADMIN_TOKEN`. If the token is not configured, write routes fail closed with `503` instead of allowing unauthenticated database changes.

Set a long random token in `apps/api/.env`:

```sh
ANICORE_ADMIN_TOKEN=<long-random-token>
```

Send it as either a bearer token or the explicit admin-token header:

```sh
curl -H "Authorization: Bearer <long-random-token>" \
  -H "Content-Type: application/json" \
  -d '{"titleRomaji":"Example"}' \
  http://localhost:3000/anime/
```

`/sync-monitor` keeps its separate monitor access-code authentication and does not require the admin token.

## Sync

The main sync fetches AniList entries in parallel by default while keeping database writes and downstream provider sync sequential:

```sh
bun run sync
```

The default fetch concurrency is `4`. Override it with `--parallel=N`:

```sh
bun run sync --parallel=8
```

Use `--parallel=1` to force the old sequential fetch behavior:

```sh
bun run sync --parallel=1
```

Parallel mode batches external fetches, waits out the equivalent AniList request budget after each batch, and temporarily falls back to sequential fetches when rate-limit or fetch errors become frequent.

### Mapping quality

Provider matching prefers published cross-references over fuzzy matching, and leaves near-tied candidates unmatched. Kitsu exposes both AniList and MyAnimeList cross-references on the payload the search already returns, and either one proves identity, so a record Kitsu links only to MyAnimeList is still recorded with `api` provenance rather than as a guess. AnimeSchedule entries carry Kitsu and MyAnimeList links too; those are only trusted after the entry's own AniList link has been confirmed to resolve to the same anime.

Fuzzy matching is the last resort. It weighs title agreement against premiere date, season, episode count and catalogue type:

- Title normalization folds Japanese long-vowel romanizations onto one form, so `Yuusha`, `Yūsha` and `Yusha` compare equal. It ignores Latin accents while preserving meaningful native-script distinctions such as Japanese voiced kana; halfwidth and fullwidth kana remain equivalent.
- Sequel markers are canonicalized across styles, so `2nd Season`, `Season 2`, `Part 2` and `II` agree. Titles carrying different explicit ordinals are capped well below a match, and a bare trailing sequel number is enough to separate a sequel from its base.
- An exact premiere date is the strongest fuzzy signal and is what separates entries in the same franchise that agree on title, year and episode count. Records more than roughly a year apart conflict outright.
- Episode counts that disagree are treated as a counting convention rather than a different work when the premiere dates match exactly, since catalogues split segments and recaps differently.
- A title that several candidates share — a franchise banner, or an anthology programme name such as `Minna no Uta` repeated on every entry beneath it — is not treated as identity evidence. A record's own primary title always is, even when its specials list it as an alternative.
- Explicit movie-versus-TV format conflicts are rejected. Missing formats and differences involving OVA, ONA or specials do not trigger that check, since those categories may differ between catalogs.

Measure matching accuracy instead of assuming it. Kitsu's authoritative AniList cross-references form a labelled corpus; the evaluator replays the fuzzy path against it with the cross-reference hidden, so the matcher has to decide from titles and metadata alone:

```sh
bun apps/api/src/scripts/evaluate-kitsu-matching-corpus.ts --sample=250 --seed=7
bun apps/api/src/scripts/evaluate-kitsu-matching.ts --verbose
bun apps/api/src/scripts/evaluate-kitsu-matching.ts --min-precision=0.99
```

The corpus builder samples the live database stratified by format and caches the Kitsu candidates it fetched; the evaluator is offline and repeatable. It reports precision, recall, abstentions, and cases where the correct record never appeared in the search results at all — a distinct failure worth separating from a scoring mistake. `--min-precision` exits non-zero so a run can gate CI. On a 250-case held-out sample the current matcher scores 100% precision at 98% recall: it prefers to abstain rather than record a wrong mapping.

Audit persisted mappings without changing database rows:

```sh
bun run db:audit-mappings
bun run db:audit-mappings --write
bun run db:audit-mappings --write=reports/mappings.json
```

`--write` defaults to `mapping-audit.json` at the repository root. Relative output paths also resolve from the repository root. The report includes finding codes, severity, affected-row counts, samples, and a summary that counts finding categories by severity.

An audit with error findings exits with status `1` and still saves its valid report. If the audit fails to produce a valid report, the saved file is preserved. Check `generatedAt` before treating a saved report as current. An audit requires a configured, reachable database; passing unit tests does not establish the quality of persisted mappings.

Review each finding's sampled identities and provider evidence before choosing a repair command. Running an audit does not repair existing rows, and improving matching logic does not retroactively validate stored mappings.

### Remote sync monitor

When the API starts, it also starts AniCore's automatic sync scheduler. By default, the scheduler runs once every 24 hours, starts immediately when no recent run exists, refreshes the AniList ID list, and performs a real sync from index `0`. It never starts another process while a manual or automatic sync is active. Change the enabled state or interval from the dashboard's Runtime Config card; the settings persist in `data/sync-monitor/runtime-config.json`.

The scheduler lives inside the API process, so keep `bun run dev` or `bun run start` running for unattended syncs. On shutdown, the API stops future scheduling, asks any sync child it started to stop gracefully, and terminates it if it does not respond within five seconds.

Set `ANICORE_AUTO_SYNC_ENABLED=false` as an operational kill switch when the scheduler must stay off regardless of the saved dashboard setting.

Automatic-sync evidence is written to API stdout and `data/sync-monitor/events.jsonl`. Grep for `sync.automatic.*` to trace scheduler dispatch/failure, `spawn.sync.*` for child-process lifecycle, `sync.lease.*` for the cross-process database lease, and `env.sync.injected` to verify the monitor environment names were supplied without exposing their values.

Start a sync with a local file-backed monitor:

```sh
bun run sync --monitor
```

This writes live status to `data/sync-monitor/status.json`, event history to `data/sync-monitor/events.jsonl`, and a generated access code to `data/sync-monitor/access-code.txt`. These files are local runtime state and are not stored in the database. The monitor directory and access-code file are restricted to the current OS user.

Run the API so another device on your LAN can reach it:

```sh
HOST=0.0.0.0 bun run start
```

Then open from the other computer using your machine IP and the generated code:

```sh
curl -H "Authorization: Bearer <code>" http://<your-ip>:3000/sync-monitor/
curl -H "Authorization: Bearer <code>" "http://<your-ip>:3000/sync-monitor/events?limit=50"
```

Opening `http://<your-ip>:3000/sync-monitor/` in a browser will prompt for HTTP Basic credentials. Use any username and the monitor code as the password.

You can also provide a stable code yourself:

```sh
ANICORE_SYNC_MONITOR_CODE=<long-random-code> HOST=0.0.0.0 bun run start
ANICORE_SYNC_MONITOR_CODE=<long-random-code> bun run sync --monitor
```

Keep `HOST=localhost` unless you intentionally want LAN access, and do not expose the monitor port directly to the public internet. Use a VPN or TLS-terminating reverse proxy if monitor traffic must leave a trusted LAN.

### Web dashboard

Start the API on the computer running the sync:

```sh
HOST=0.0.0.0 CORS_ORIGIN=http://localhost:5173 bun run start
```

Start the web dashboard:

```sh
VITE_ANICORE_API_URL=http://<api-ip>:3000 bun run dev:web
```

Paste the monitor code into the dashboard after it loads. The dashboard keeps it in session storage, so the code is not compiled into the public web bundle or persisted across browser sessions.

For Windows PowerShell:

```powershell
$env:HOST="0.0.0.0"; $env:CORS_ORIGIN="http://localhost:5173"; bun run start
$env:VITE_ANICORE_API_URL="http://<api-ip>:3000"; bun run dev:web
```

## Proxy support

Provider HTTP calls can run through a proxy when the API or sync scripts are started with one of these environment variables:

```sh
ANICORE_PROXY_URL=http://host:port bun run sync
HTTPS_PROXY=http://host:port bun run sync
HTTP_PROXY=http://host:port bun run sync
```

`ANICORE_PROXY_URL` takes priority over the standard proxy variables. `NO_PROXY` is also honored for hostnames that should bypass the proxy.

For disposable public proxies, set:

```sh
ANICORE_USE_FREE_PROXY=1 bun run sync
```

That loads and rotates the free HTTP proxy list from ProxyScrape's raw text endpoint. Because public proxies are unreliable, AniCore tries multiple proxies for each request and falls back to a normal direct fetch if none of the attempted proxies work.

Proxy state is cached under `data/cache`:

- `proxies.txt` - the reusable proxy pool, hydrated from ProxyScrape when stale
- `working_proxies.txt` - proxies that successfully completed a request
- `dead_proxies.txt` - proxies that failed a request and should be skipped

The default free-proxy attempt limit is 25 per request. Override it with:

```sh
ANICORE_USE_FREE_PROXY=1 ANICORE_FREE_PROXY_MAX_ATTEMPTS=50 bun run sync
```

Public proxies should not be used for sensitive authenticated provider calls.
