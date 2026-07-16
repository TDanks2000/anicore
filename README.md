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
bun run build
bun run typecheck
bun run test
```

Root commands force Turbo's stream UI so Windows shells avoid the interactive UI path that can fail with exit code 56.

Put API secrets in `apps/api/.env`. The old root `.env` was copied locally to `apps/api/.env` during the migration if it existed.

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

### Remote sync monitor

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
