# Catalogue performance

Measured locally on 2026-10-06 with 30,000 synthetic anime records, Bun 1.4.3
(local canary installation) and SQLite 3.45.1. Each record has approximately 1 KB
of synopsis text, six searchable text fields, and deterministic score/popularity
ties and nulls. Each scenario has five warmups and 30 measured calls to
`listAnime`, including its count query and response formatting. These are warm
service-call measurements, not HTTP latency or production guarantees.

## Results

Baseline versus the indexed implementation, median / p95 in milliseconds:

- First page: **1.84 / 3.43 → 1.99 / 3.19**. No meaningful gain expected here.
- Substring search (`naruto`, 80 matches): **157.06 / 165.75 → 3.94 / 4.74**.
- TV filter, score descending (24,000 matches): **84.08 / 89.49 → 4.35 / 5.84**.
- Popularity descending: **147.48 / 152.04 → 1.66 / 2.98**.
- Title ascending: **84.94 / 89.94 → 1.62 / 2.78**.
- Deep pagination (offset 24,000): **42.84 / 51.27 → 2.26 / 2.66**.

Storage increased from 45,350,912 to 56,467,456 bytes (about 25%). Inserting the
entire fixture increased from 6,576 to 10,828 ms (about 65%). These costs buy
faster reads; measure real sync throughput before assuming a net improvement
for a write-heavy deployment. The search index only covers searchable text,
and its update trigger skips unchanged text even when other metadata changes.

## Implementation and correctness

Title, score, popularity, format/score and compact ID indexes support common
catalogue access paths. Query plans for the measured sorts use the new indexes
without temporary sort trees. Other filter/sort combinations can still need a
scan or temporary sort; the benchmark does not claim all combinations improved.

An external-content FTS5 trigram index narrows substring searches of at least
three Unicode characters. The original escaped `LIKE` expressions still verify
each candidate across all six original fields. One/two-character and NUL-bearing
queries use the original path. Search ranking, literal wildcard handling, JSON
synonym matching, filters, counts and null/tie ordering retain their contracts.
Database triggers keep the index aligned with inserts, text updates, deletes and
transaction rollbacks. The migration rebuilds the index for existing records.

For offsets of at least 1,000, one SQL statement finds the page IDs before
hydrating full records. This avoids reading large descriptions for skipped rows
and keeps page selection and hydration in one SQLite statement/snapshot.
Offset pagination still scales with the number of skipped index entries.

The dashboard caches at most 20 catalogue pages per mounted hook, keyed by
server and complete query, for 30 seconds. Expired pages remain visible during
revalidation. Visible pages periodically revalidate; hidden tabs skip polling.
Manual Refresh invalidates all cached pages. A failed refresh retains the matching
page and displays a warning; rows from a different query/server are never shown
as its result. Cached reads can be up to 30 seconds old under normal operation,
and retained data can be older after a failed refresh.

Integration tests compare indexed searches to the original literal-search oracle,
including native text, emoji, quotes, wildcard characters and NULs. They also
check migration backfill, trigger maintenance, rollback integrity and deep pages
with nulls/ties in both sort directions. Cache tests cover freshness, capacity
and explicit invalidation.

A browser smoke check with synthetic responses confirmed that returning to a
fresh page sends no new request, manual Refresh forces a request and invalidates
other pages, and a simulated failed refresh retains the page with a warning.
Restoring successful responses clears the warning.

## Reproduce

From the repository root:

```sh
bun --cwd apps/api src/scripts/benchmark-catalogue.ts
bun --cwd apps/api src/scripts/benchmark-catalogue.ts --rows=10000
```

The command creates, migrates, populates and removes a temporary database. It
does not open the configured application database. A separate worker owns SQLite
handles so cleanup works on Windows after that worker exits. JSON output contains
the runtime versions, fixture size, timings and representative query plans.

For end-to-end measurements against a running API, use `bun run benchmark`.
Compare equivalent data and settings, including during sync; do not equate these
synthetic local results with real user response times.

Existing databases receive migrations through the normal migration/startup path.
The first application of the search migration must build the index; its duration
and additional disk use depend on the catalogue size and text. No live database
was changed while producing this benchmark.
