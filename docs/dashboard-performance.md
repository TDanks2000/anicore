# Dashboard loading and request reliability

Verified locally on 2026-10-06. Production builds use the pinned workspace
dependencies; the local Bun runtime is 1.4.3-canary.1.

## Loading

The previous build emitted one 354.47 KB JavaScript entry (106.66 KB gzip).
The split build emits a 275.27 KB entry (87.33 KB gzip), plus separately loaded
monitor (36.01 KB / 10.32 KB gzip), catalogue (26.76 KB / 8.34 KB gzip), detail
dialog (19.09 KB / 5.72 KB gzip), and shared card (2.03 KB / 0.78 KB gzip) chunks.
CSS is approximately unchanged at 39.27 KB / 8.02 KB gzip.

The entry is about 22% smaller, but the selected view and its dependencies still
load on entry. A monitor visit needs about 313 KB of JavaScript across those
chunks instead of 354 KB; visiting everything eventually downloads slightly
more total JavaScript because of chunk/runtime overhead. These are build sizes,
not measured startup timings. Network conditions and browser caches matter.

The inactive view is fetched on demand, with hover/focus prefetch for navigation.
Details load on first selection. Once loaded, the detail component stays mounted
when closed so its bounded cache survives subsequent opens. Loading states are
announced with `role="status"`; failures leave the app shell usable and offer
Reload dashboard. Navigation resets a failed view boundary.

Browser checks confirmed that the initial monitor visit did not load catalogue
or detail modules; selecting the catalogue loaded its view without the detail
module; selecting an anime loaded and opened the native dialog. Closing and
reopening a fresh detail reused its cached responses. Navigation remained usable
after a deliberately malformed fixture triggered a content boundary.

## Requests

Catalogue and detail reads now share the monitor client's 15-second request
deadline via `@anicore/sync-monitor/request`. It covers both headers and body
consumption. Caller cancellation preserves its reason, and already cancelled
calls never begin their operation. Timer and caller listener are released on
both success and failure, preventing completed polls from retaining cancellation
listeners or pending deadline timers.

A timed-out request reports a recoverable error. Existing matching cached data
remains visible during failed refreshes. The detail aggregate cancels its sibling
read when either response fails, and skips periodic refreshes in hidden tabs.
No writes retry automatically, and API response formats remain unchanged.

Regression tests exercise stalled response bodies, deadlines, caller cancellation,
invalid timeout values and cleanup. Full workspace tests, type checks, lint,
production build, catalog policy and frozen installation passed after this batch.

Further tuning should use end-to-end measurements during a real sync on a
representative catalogue. Bundle size reductions and synthetic database latency
alone cannot establish the user-visible speed or sync throughput of a deployment.
