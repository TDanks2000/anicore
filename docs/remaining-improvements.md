# Remaining improvement implementation

The code portions of the original twelve-item plan are implemented. Live rollout
measurements and collection of new upstream-labelled evaluation cases are separate
operational work; no production database, mappings or upstream catalogue was
modified during validation.

## Read concurrency and API compatibility

Public catalogue, episode, mapping and language service reads use a separate
SELECT-only libsql connection. It waits for WAL/migrations, enforces `query_only`,
and serializes its own statements. The original writer mutex, whole-transaction
lock, busy retries and sync lease remain intact. Reads see committed data, not
the writer's uncommitted state. Code inside write transactions must keep using
`tx`; independent reads do not join that transaction.

Instrumentation additionally records `db.read_lock_wait` and `db.read_execute`.
The isolated benchmark now exercises reads while 30 write transactions each
hold their transaction open for 10 ms. On 10,000 synthetic records with stable
Bun 1.4.2, summary reads measured 1.26 ms median / 2.98 ms p95, with the write
loop completing in 633 ms. This is a contention check, not a live sync benchmark.

`GET /anime` retains the bare array, full rows, offset pagination and exact
`X-Total-Count` by default. Add `projection=summary` to omit synopsis, banner,
trailer and hashtag fields at SQL selection time; the table now uses this option.
Full detail endpoints retain their original response shape.

ID cursor pagination is additive: request `pagination=cursor&sort=id&offset=0`,
then pass the returned `X-Next-Cursor` as `afterId` with the same filters and order.
An empty header means there is no next page. Both ascending and descending ID
order work. Counts remain the full filtered total, independent of the cursor.
Non-ID sorts, nonzero offsets, and search without explicit ID sorting are rejected
in cursor mode. The cursor is a position, not a frozen catalogue snapshot; keep
filters/order unchanged between pages. Existing sorted offset browsing remains
supported and optimized.

## Selective sync and recovery

Automatic syncs use `--selective`. Manual `bun run sync` remains a full refresh;
use `bun run sync --selective --from-index=0` for selective manual runs or
`bun run sync --reconcile --from-index=0` to explicitly force all stages.
Selective runs perform a full reconciliation when none has completed or the last
complete reconciliation is at least 30 days old. A limited/stopped/failed run does
not advance that reconciliation marker.

Each AniList ID has durable stage records for its source fetch, anime upsert,
provider plugin, episode titles and each language provider. Successful stages store
their current result and freshness deadline. Active/upcoming/unknown-status titles
refresh every six hours. Finished/cancelled metadata refreshes every seven days;
their language stages refresh daily. Language freshness is independent of metadata
freshness, so cached AniList metadata does not suppress a due dub/cast check.
Confirmed source 404s are cached for 30 days and count as skipped, with forced
reconciliation able to check them again. A missing local mapping forces rebuilding
previously stored stage results rather than reusing a deleted anime ID.

Failures preserve previously successful stages and get exponentially increasing
retry cooldowns, from one minute up to one hour. Retrying an interrupted pipeline
reuses fresh successful results and retries due failures. Explicit reconciliation
bypasses stage caches/cooldowns. In-flight duplicate stage requests share one
promise. Cached stage payloads occupy one current snapshot per ID/stage, not an
unbounded attempt history. This adds database writes/storage; measure real sync
throughput and catalogue freshness before changing the documented intervals.

Required language-provider errors now fail the item so the existing durable
checkpoint cannot advance past an incomplete refresh. Optional provider warnings
keep their previous treatment and can retry on a later run. Identity checks,
manual overrides and authoritative association removals retain their safeguards.
Provider HTTP requests receive a 30-second deadline combined with caller
cancellation; provider-specific retries/rate limiting continue to apply.

The sync engine consumes fetched items in checkpoint order as soon as they are
ready, while other requests in the same bounded window continue. Processing and
writes remain sequential between items, pause/stop checks stay at batch boundaries,
and the adaptive rate-limit backoff remains. Windows are limited to 32 requests.
Source-cache hits do not consume the remote request budget or its wait time.
There is no speculative next-batch fetch while a batch is being committed.

## Logs and freshness

Monitor tails are cached by path, requested limit, inode, size and nanosecond
mtime/ctime. File changes and rotations invalidate the cache; callers receive
copies of parsed events. Reads retain their byte/line budgets. Messages are bounded
after JSON serialization so malformed/oversized messages cannot evade the reader.

Monitor and CORS logs rotate at approximately 5 MiB, retaining three archives
(`.1` newest through `.3` oldest). Concurrent threshold races may overshoot by a
few lines. A process-owned lock prevents competing rotations; exited-writer locks
are recoverable. Ordinary append operations avoid that lock. A temporarily blocked
rotation retains new events and retries on a later append. The dashboard tail
shows the current file; archived history remains available on disk.

Transactional revision triggers cover metadata, children, mappings and language
rows. `GET /anime/revision` exposes the current revision. The visible catalogue
polls it every 30 seconds and invalidates page/detail caches after changes,
including imports and language refreshes. Hidden tabs skip polling. Rollbacks do
not publish a revision. The detail header uses refreshed metadata too.

`GET /anime/:id/freshness` exposes stage success/due/retry timestamps and failure
counts, without cached payloads or error messages. The detail dialog shows known
provider freshness and pending retry/due states. Older databases have no recorded
stage history until their next sync. Failed refreshes still retain usable cached
data, with a warning, and the manual Refresh path remains available.

## Quality, audits and backups

The held-out corpus builder adds `--coverage` to guarantee sampling across the
available format/sequel-marker/segmentation cohorts. It requires a sample large
enough to cover all available cohorts. Sequel markers are sampling heuristics,
not new identity evidence. Expected identities still come from authoritative
Kitsu references. Cached cases are reused only when their expected identity agrees.
Reports now include per-cohort metrics; optional gates fail closed on insufficient
cases or unmeasurable precision:

```sh
bun --cwd apps/api src/scripts/evaluate-kitsu-matching-corpus.ts --coverage --sample=300 --seed=7
bun --cwd apps/api src/scripts/evaluate-kitsu-matching.ts --min-precision=0.99 --min-cohort-precision=0.99 --min-cohort-cases=5 --write
```

No new real-world labelled corpus was fabricated or fetched during code validation.
Gather an independent sample before using cohort results as evidence of accuracy.
Existing mapping, language-coverage and manual-override regressions still run in
the normal CI test suite.

While the API is running, mapping/language audits run every 24 hours, defer when
sync is active, run single-flight, and persist their last completion across
restarts. Set `ANICORE_AUDIT_INTERVAL_HOURS=0` to disable or a positive value to
change the interval. Reports are atomically saved to `data/audits/latest.json`,
relative to the API working directory; integrity findings are monitor error events.
Failures preserve the previous report and retry after 15 minutes. Audits report
problems and do not repair data automatically.

Backup commands intentionally have no extra package aliases:

```sh
bun --cwd apps/api src/scripts/database-backup.ts create data/backups/snapshot.db
bun --cwd apps/api src/scripts/database-backup.ts verify data/backups/snapshot.db
bun --cwd apps/api src/scripts/database-backup.ts restore data/backups/snapshot.db data/backups/restored.db
```

Creation uses SQLite `VACUUM INTO` for a consistent snapshot including committed
WAL content. Verification checks SQLite integrity, foreign keys and FTS agreement.
Creation/restoration refuse existing destinations. Restore produces a **new file**;
stop the API/sync and point `DATABASE_URL` to that verified file to activate it.
Workers release native SQLite handles before cleanup on Windows. Restore tests
check committed snapshot contents and preservation of manual language overrides.
Backup copies are not encrypted by this tooling; manage their storage/access as
you do the application database. Automatic backup retention/offsite copies are
operational policy, not implied by these commands.

All migrations are generated/versioned and applied through the existing startup
path. Code validation used isolated databases; deployment still needs a backup,
migration timing/storage checks on representative data, a fresh held-out corpus,
and API measurements during a real sync.

Final validation on Bun 1.4.2: 477 tests passed with no failures, all workspace
type checks and the production build passed, Biome passed, dependency catalog
checks passed, and migration generation reported no outstanding schema changes.
The production dashboard also opened catalogue/details successfully against mock
responses in the collaborative browser; this does not validate a live deployment.
