# Improvement phase progress

## Phase A — first read-only slice delivered

The dashboard has a **Review** view at `#/review`. Supply `ANICORE_ADMIN_TOKEN`,
not the monitor code. The token stays in component memory and is discarded when
disconnecting, navigating away, changing the API URL or receiving an authentication
failure. No review writes are enabled in this slice.

The queue shows joined anime titles, uncertainty status and evidence weight. It
supports language code, audio/subtitle and unknown/possible filters, with 25-row
pages, totals, refresh, empty states, request cancellation and authentication errors.
Selecting a result opens the existing detail dialog in that result's language.

`GET /admin/language-status/review-queue` retains its original bare array of status
rows by default. `includeAnime=true` adds an `anime` title object per row. Optional
`languageCode`, `mediaType` and `status` filters apply before pagination, with regional
language normalization. `X-Total-Count` reports the filtered total. Responses use
`Cache-Control: no-store`; existing admin authorization and CORS header exposure
remain in effect.

The detail dialog's **Why this result? Mappings & coverage** inspector shows stored
provider identity, primary/secondary status, provenance, evidence weight and segment
offset/boundaries. It distinguishes missing, unknown and available recorded normal
episodes from expected episodes with no local record. Partial episode coverage and
an incomplete or unknown episode denominator do not establish complete coverage.
Historical matching/abstention diagnostics are labelled unavailable rather than
invented. Evidence weights are displayed as scores out of 100, not probabilities.

Still outstanding in Phase A: override editing, a durable before/after change journal,
stale-edit checks, persistent review workflow state and richer reason/provider filters.
Phases B–D remain planned in `anicore-feature-plan.html`.

## Crunchyroll challenge interruption — addressed

Anonymous token acquisition now sends an explicit web client/device grant and asks
for JSON. Both the previous request and updated request worked from this machine;
the reported upstream 403 was not reproducible here. A live read through the updated
client fetched Cowboy Bebop's series, one season and 26 episodes, including audio
and subtitle locales. No application database was changed by this probe.

The client recognizes the documented `cf-mitigated: challenge` response header and
a bounded prefix of older HTML challenge pages. See
[Cloudflare's challenge response documentation](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/).
It raises a concise typed access-block error without copying challenge HTML into
logs and opens a 15-minute process-local circuit. Queued callers observe that circuit
before making another request. When it expires, anonymous token acquisition retries.

An access challenge is a language-provider warning, so other language sources can
continue. It still fails the durable Crunchyroll stage: no empty snapshot or success
is written, and existing evidence/mappings survive. Persisted retry cooldowns for
that specific challenge remain warnings after process restart. Ordinary authorization,
identity and payload errors remain required failures. The standalone audio-sync CLI
uses the same classification.

This handling cannot guarantee Crunchyroll will accept future requests from a
particular network. If its protection blocks a request, AniCore reports degraded
Crunchyroll freshness and retains known data while retrying later.

## Verification

- API suite: 212 tests passed, including queue compatibility/authentication and
  challenge stage recovery on temporary databases.
- Provider suite: 220 tests passed, including challenge detection, concurrent
  request gating, recovery after cooldown and one-time 401 token refresh.
- Dashboard suite: 62 tests passed, including conservative coverage resolution,
  authenticated client cancellation and review routing.
- API, provider and dashboard type checks passed; the dashboard production build passed.
- Browser verification used isolated in-page response fixtures, with no production
  reads or mutations: queue connection, filters/empty states, Portuguese evidence
  selection, segment inspection, expired-session cleanup and desktop/mobile layout.
  The admin token was absent from local/session storage and request URLs.
