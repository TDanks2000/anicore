# AniCore

AniCore is a unified anime metadata API. It maps anime and episodes across AniList, Kitsu, TheTVDB, TMDB and other catalogues, and tracks dub and subtitle availability per language.

## Quick start

Requires [Bun](https://bun.sh) 1.3. Data lives in a local SQLite file (`apps/api/data/anicore.db`), so there is no database server to run or pay for.

```sh
bun install
cp apps/api/.env.example apps/api/.env   # set ANICORE_ADMIN_TOKEN
bun run dev                              # API on :3000, dashboard on :5173
bun run sync                             # populate the database from AniList and friends
```

The database file is created and migrated automatically the first time anything opens it. Set `DATABASE_URL` to a file path to keep it elsewhere; to back it up, stop the API and any sync, then copy `anicore.db` along with its `-wal` and `-shm` files if present.

Interactive API docs are served at `http://localhost:3000/docs` (OpenAPI JSON at `/docs/json`).

## Architecture

AniCore is a Bun workspace driven by Turborepo:

| Package | Purpose |
| --- | --- |
| `apps/api` | Elysia HTTP API, the sync runner, and database maintenance scripts |
| `apps/web` | Vite + React + Tailwind v4 dashboard for monitoring and controlling syncs |
| `packages/db` | Drizzle schema, migrations' source of truth, shared enums, the database client |
| `packages/providers` | Provider clients, mappers, matching, and the idempotent provider upsert |
| `packages/sync-monitor` | Sync monitor types and the browser client used by the dashboard |

Inside the API, each module under `src/modules` has routes (validation and HTTP shape only) and a service (queries, transactions and business rules). Services throw `HttpError` for client errors; the global error handler turns those into responses and classifies database constraint violations by their SQLite result code.

The sync pulls every AniList ID, upserts the anime, then runs provider plugins (Kitsu matching, episode title enrichment from TheTVDB/TMDB, and dub/sub status) for it. A database lease in `sync_runs` ensures only one sync process runs at a time; provider upserts are safe to run concurrently with API imports.

## API

Reads are public. Every write, and every route under `/admin`, requires the admin token. `/sync-monitor` uses its own access code (see below).

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/anime` | List anime. `q` searches titles, synonyms and slugs (exact and prefix matches first); filter with `format`, `season`, `seasonYear`, `status`; sort with `sort` (`id`, `title`, `format`, `status`, `seasonYear`, `episodes`, `score`, `popularity`) and `order` (`asc`, default, or `desc`; missing values sort last); paginate with `limit` (1–100, default 50) and `offset`. The body is an array and `X-Total-Count` reports the number of matching rows. |
| `GET` | `/anime/:id` | One anime. `/full` adds mappings, episodes, studios, tags, external links and relations. |
| `GET` | `/anime/:id/{mappings,episodes,studios,tags,external-links,relations}` | Child collections of an anime. |
| `GET` | `/anime/by/:provider/:providerId` | The anime a provider ID maps to, with that mapping. |
| `GET` | `/anime/:id/{language-status,dub-status,subtitle-status}` | Resolved language availability with its evidence. |
| `POST` | `/anime` | Create an anime, optionally with mappings. A slug is generated from the title when omitted. |
| `POST` | `/anime/import/anilist` | Import or refresh from AniList by `{ "id": 1 }` or `{ "search": "Cowboy Bebop" }`. |
| `POST` | `/admin/anime/:id/language-refresh` | Refresh language providers for a stored anime; returns statuses, evidence, errors and optional-provider warnings. |
| `GET` | `/episodes`, `/episodes/:id`, `/episodes/:id/{full,mappings,audio}` | Episodes and their mappings and language status. |
| `POST` | `/episodes`, `/episodes/:id/audio` | Create an episode, record audio status. |
| `GET` `POST` `PATCH` `DELETE` | `/mappings/{anime,episode}/...` | Look up, create, update and delete provider mappings. |
| `POST` | `/admin/anime/:id/language-{evidence,override}` | Record language evidence or a manual override. |
| `GET` | `/admin/language-status/review-queue` | Low-confidence language statuses to review. |
| `GET` | `/health`, `/health/ready` | Liveness, and readiness including a database check. |

GET requests never change data or call external providers. Missing records return `404`, conflicts `409`, and invalid input `400` with the failing field paths:

```json
{ "error": "Validation failed", "issues": [{ "path": "/id", "message": "Property 'id' should be integer" }] }
```

### Mapping rules

- A provider ID belongs to at most one anime (and one episode).
- Each anime has at most one primary mapping per provider. A provider's first mapping is primary by default; adding another requires the existing primary to stay, or the new one to be marked primary, which demotes the old one. A primary cannot be cleared or deleted while others exist.
- Episode mappings for a provider require an anime-level mapping for that provider, and an anime-level mapping cannot be deleted while episode mappings depend on it.

### Authentication

Set a long random token in `apps/api/.env`:

```sh
ANICORE_ADMIN_TOKEN=<long-random-token>
```

Send it as a bearer token or in `X-Anicore-Admin-Token`:

```sh
curl -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"id": 1}' http://localhost:3000/anime/import/anilist
```

When no token is configured, admin routes fail closed with `503`. Authentication runs before request bodies are parsed.

## Development

```sh
bun run dev          # API and dashboard with reload
bun run lint         # Biome lint and format check (bun run lint:fix to apply)
bun run typecheck
bun run test
bun run build
bun run start        # build, then serve the API with the automatic sync scheduler
```

Root commands force Turbo's stream UI so Windows shells avoid the interactive UI path that can fail with exit code 56.

### Integration tests

API integration tests run as part of `bun run test` against a throwaway SQLite file: a test preload (`apps/api/src/test/preload.ts`) points `DATABASE_URL` at a temporary directory, so tests never touch your real database.

CI runs lint, typecheck, and the full test suite, including integration tests, on every push and pull request.

### Schema changes

Edit `packages/db/src/schema.ts` (or `provider-mapping-schema.ts`), then generate and apply a migration:

```sh
bun run db:generate
bun run db:migrate
bun run db:check-shape
```

Closed value sets such as providers and mapping sources live in `packages/db/src/enums.ts`; the schema, request validators and provider types all derive from it.

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

### Dub and subtitle evidence

Language refreshes use five sources independently: Crunchyroll's per-episode audio and subtitle tracks, AnimeSchedule's English audio/subtitle tracks, AniList voice cast, MAL voice cast through Jikan, and explicit Kitsu streaming-link language metadata. Importing an anime refreshes its language evidence immediately, and normal scheduled syncs refresh it again. Jikan's upstream outages are reported as warnings while the other providers continue; repeated failures open a short cooldown. Cached MAL cast data is valid for 24 hours.

Identity must be proven before attaching languages. AnimeSchedule searches by published AniList ID and verifies cross-reference hosts and IDs. Voice cast and streaming metadata require one authoritative mapping at confidence 100; fuzzy mappings cannot supply language evidence. Conflicting identities are reported and their automatic evidence is withdrawn. Successful provider snapshots replace that provider's previous evidence transactionally, including retired URLs; failed requests preserve the last successful snapshot. Manual overrides are preserved.

`confirmed` establishes language-track existence, not complete episode coverage. AnimeSchedule's missing premiere date does not mean there is no dub: its documented release-time markers also identify tracks. Empty schedules and missing cast credits remain unknown. Cast credits and Kitsu catalogue metadata produce `likely` evidence at confidence 75; direct schedule track evidence scores 90 and Crunchyroll's own track listing 95. These scores are evidence weights, not measured probabilities. Streaming catalogue evidence describes historical language existence, not current licensing or availability in a particular country.

Episode availability requires a past explicit premiere or release batch and compatible episode numbering. A finished Japanese broadcast does not prove that every dubbed episode has released. Release-time timestamps only describe the clock time; their date portion is never interpreted as a release date. The dashboard shows source evidence and unknown episode coverage as `?`, and deduplicates overlapping provider rows. `dub-status` and `subtitle-status` return the same resolution as `coverage`: one status per canonical episode and the available/missing/unknown totals.

Language codes are stored by their primary subtag (`pt-BR`, `Portuguese (BR)` and `Portuguese` are all `pt`), because providers disagree on regional precision for the same track and keeping it would split one dub into several partial-looking rows.

#### Crunchyroll episode tracks

Crunchyroll lists every audio version and subtitle locale per episode, so it is the only source that maps dubs and subtitles onto individual episodes of finished shows. Its seasons rarely match AniList entries one to one (Attack on Titan's 22-episode third season is two AniList entries; One Piece spans 24 arc seasons numbered absolutely), so each anime is aligned to a slice of the Crunchyroll series and recorded as a segment mapping (`anime_provider_mappings` + `anime_provider_segments`, e.g. Crunchyroll 50–59 → local 1–10) with a `crunchyroll` episode mapping per episode.

- The series comes from the anime's own Crunchyroll link (modern `/series/<id>` links directly, pre-2022 slug links by matching `slug_title`). Without a link, only a series whose title matches exactly, that launched no later than the anime, and whose episode aired on the anime's premiere date is accepted, recorded with `fuzzy` provenance and confidence 90.
- An alignment must be anchored, by the premiere date (a mid-season match only if everything before it aired earlier) or by an exact fit of a whole season, and complete for finished anime. Recaps (`13.5`), specials (`SP1`) and PVs never take an episode number. Seasons whose dates are bulk upload dates are treated as undated. Episode titles veto alignments that are clearly shifted. Any tie, contradiction or gap abstains.
- When several anime publish the same Crunchyroll link and its seasons are otherwise indistinguishable (Vandread and its second stage: two 13-episode seasons with only upload dates), each anime takes the season at its premiere-ordered position, but only if the anime and the numbered seasons pair one to one with equal episode counts.
- A linked single-season series that cannot be aligned still supplies anime-level tracks, with no per-episode claims, if the season is plausibly the same work: not a film, about the same episode count, and from the same years.
- The catalogue is regional (requests bypass rotating proxies), so Crunchyroll only ever records presence: a track it lacks is unknown, never missing.
- Missing English episode titles and lengths are filled from aligned Crunchyroll episodes; existing values are never overwritten, and numbered placeholders ("Episode 12") are neither stored nor used to veto an alignment.

```sh
bun run sync:audio                        # refresh all stored anime languages
bun run sync:audio --anime-id=1           # refresh one internal anime ID
bun run sync:audio --dub-only --limit=50  # refresh provider evidence without rebuilding original audio
bun run db:audit-languages --write=data/cache/language-audit.json
```

The audit checks evidence/status agreement, authoritative identity ownership (including Crunchyroll segment and episode mappings), unsupported schedule and regional-catalogue negatives, noncanonical episode rows and noncanonical language codes. It measures database consistency; it does not guarantee upstream accuracy or fill gaps with guessed data. See [the live validation results](docs/language-mapping-validation.md).

Provider semantics: [Crunchyroll](https://www.crunchyroll.com) public catalogue API (anonymous web client, metadata only), [AnimeSchedule track documentation](https://animeschedule.net/api/v3/documentation/anime), [AniList character voice actors](https://docs.anilist.co/reference/object/characteredge), [Jikan character/cast API](https://docs.api.jikan.moe/), [Kitsu streaming-link attributes](https://github.com/hummingbird-me/kitsu-server/blob/master/app/resources/streaming_link_resource.rb).

### Cross-provider matching

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

Cross-origin requests are logged (allowed or blocked) with the origin and the configured allow-list. Lines are printed to the API console and appended to `apps/api/data/logs/cors.log`; override the path with `ANICORE_CORS_LOG`.

For Windows PowerShell:

```powershell
$env:HOST="0.0.0.0"; $env:CORS_ORIGIN="http://localhost:5173"; bun run start
$env:VITE_ANICORE_API_URL="http://<api-ip>:3000"; bun run dev:web
```

## Proxy support

The dashboard's **Cache & proxies** card shows managed cache files, file sizes, update times and bounded content previews, plus working, untested and dead proxy counts. Clear individual Jikan or unmatched-provider caches while sync is idle; checkpoints, ID lists and proxy pools remain read-only.

Choose **Disabled (direct)**, **Custom proxy**, **Enable free proxy pool**, or **Use environment**, then save. Proxy mode, bypass hosts, free-pool attempt limit and timeout persist in `apps/api/data/sync-monitor/proxy-config.json` and apply to new API and sync requests without a restart. Existing requests keep their routing. Custom URLs accept HTTP(S), including credentials; responses redact credentials, and leaving the URL field blank preserves the saved URL. Environment mode restores the environment-variable behavior described below.

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

That loads and rotates the free HTTP proxy list from ProxyScrape's raw text endpoint. Because public proxies are unreliable, AniCore tries multiple proxies for each request and falls back to a normal direct fetch if none of the attempted proxies work. A proxy that answers with its own error page (a non-JSON 4xx/5xx other than 404) counts as dead rather than as the API's reply. Kitsu, TheTVDB, TMDB, AnimeSchedule and Crunchyroll always bypass the free pool.

Proxy state is cached under `data/cache`:

- `proxies.txt` - the reusable proxy pool, hydrated from ProxyScrape when stale
- `working_proxies.txt` - proxies that successfully completed a request
- `dead_proxies.txt` - proxies that failed a request and should be skipped

The default free-proxy attempt limit is 25 per request. Override it with:

```sh
ANICORE_USE_FREE_PROXY=1 ANICORE_FREE_PROXY_MAX_ATTEMPTS=50 bun run sync
```

Public proxies should not be used for sensitive authenticated provider calls.
