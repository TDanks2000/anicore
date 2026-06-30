AniCore is a unified anime metadata API for mapping anime, episodes, and dub/sub availability across sources like AniList, Kitsu, and streaming providers.

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

This writes live status to `data/sync-monitor/status.json`, event history to `data/sync-monitor/events.jsonl`, and a generated access code to `data/sync-monitor/access-code.txt`. These files are local runtime state and are not stored in the database.

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
ANICORE_SYNC_MONITOR_CODE=change-me HOST=0.0.0.0 bun run start
ANICORE_SYNC_MONITOR_CODE=change-me bun run sync --monitor
```

Keep `HOST=localhost` unless you intentionally want LAN access, and do not expose the monitor port directly to the public internet.

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
