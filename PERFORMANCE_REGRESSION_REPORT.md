# Banglas Playing Tennis — performance regression investigation

Investigation date: 2026-09-23 (Australia/Sydney)

Scope: read-only diagnosis of the reported slow loading. No production deploy, database write, migration, UI redesign, or speculative performance fix was performed.

## 1. Exact versions

The Netlify project `banglasplayingtennis` was inspected while authenticated in the Netlify dashboard. Production was shown as:

- Commit: `c21bf3b26cb0d641cebd928b9d3f7be61bf8a156` (`Make sign-in state refresh non-blocking`)
- Deploy ID: `6ab2aa4ae2e5bc0008bc0fb9`
- Published: 2026-09-23 02:18 (dashboard display time)

Relevant history, with complete SHAs:

| Role | Commit |
| --- | --- |
| Last pre-upgrade baseline | `d4b9ac6` (`Anchor notification count to bell`) |
| Failed large reliability release | `e61723c65c274a0290e659e673a37d985c42c08a` (`Harden app reliability and notification context`) |
| Operational rollback | `d6a72ce476b49c79c4521ac997d25de6ebd187eb` (`Rollback broken release keep notification updates`) |
| Compatibility re-application | `5f8a3d26e2e18bbc4f04c3fafcbb0f122daae58f` |
| Timeout/loading adjustment | `4a2366cac4a74df78f20cdba0d7988bb2d11db10` |
| Current production | `c21bf3b26cb0d641cebd928b9d3f7be61bf8a156` |

The local working tree also has one unrelated, uncommitted `public/index.html` notification-read change. It was preserved and is not part of this investigation.

## 2. Loading sequence and code paths

The initial browser path is:

1. HTML loads and registers `public/sw.js`.
2. The inline app script calls `refresh()`.
3. `request('state')` calls `transportRequest()` with an 8-second abort and two GET attempts (`BPTExperience.retry`).
4. Netlify `api.mjs` handles `action=state` through `appState()`.
5. `appState()` queries players, events, EOIs, payments, scores, live matches, notes, and badges in one `Promise.all`.
6. It validates the player/admin session, signs permitted avatar URLs, creates pending payment notifications, reads notifications, and returns the state payload.
7. The browser calls `render()`, which currently invokes all page renderers, including hidden pages, before dismissing the loading overlay.

Media is lazy-loaded when the Media page is opened. Live and EOI polling are page-gated, but their intervals remain registered globally (3 seconds for live state and 10 seconds for EOI state). Realtime setup starts after 1.2 seconds and the sync-version check runs every 5 minutes in the current build.

## 3. Production measurements

These measurements were made against the deployed site on 2026-09-23 using `test/performance.mjs` (no credentials and no private response bodies). They are signed-out measurements; authenticated player/admin timings remain unverified because no synthetic credentials or token were supplied.

| Request | Result | Duration | Payload |
| --- | ---: | ---: | ---: |
| HTML | 200 | 113 ms | 315,652 bytes |
| `state` cold-ish | 200 | 1,592 ms | 6,631 bytes |
| `state` warm | 200 | 983 / 969 / 959 / 524 ms | 6,631 bytes |
| `eoi-state` | 200 | 1,063 ms | 13,110 bytes |
| `live-state` | 200 | 510 ms | 57 bytes |
| `sync-version` | 200 | 940 ms | 102 bytes |
| `realtime-config` | 200 | 308 ms | 84 bytes |
| `media-state` | 200 | 269 ms | 90 bytes |

The health endpoint returned HTTP 200 with database, session-signing, and push checks true. The current production endpoint therefore does not reproduce the reported 30-second delay under this signed-out test.

Network analysis found no non-200 responses in the harness and no duplicate request within a single harness sample. The payloads are small except for the 315 KB HTML shell. Supabase per-query server timings are not exposed by the public API response, so the `Promise.all` members cannot be ranked from this run.

### Browser rendering analysis

The live app DOM became available during inspection, but this environment did not expose a usable browser Performance/Network panel for authenticated timings. Source inspection confirms that `render()` invokes hidden page renderers as well as the active page; the cost of that work was not measured and is therefore a hypothesis, not a confirmed bottleneck.

The harness can be repeated with:

```sh
node test/performance.mjs --base=https://banglasplayingtennis.netlify.app
```

For an authorized isolated test account, the same harness now accepts tokens
without printing them or response bodies:

```sh
BPT_PLAYER_TOKEN='...' node test/performance.mjs --base=https://staging.example
BPT_ADMIN_TOKEN='...' node test/performance.mjs --base=https://staging.example
```

No staging URL, synthetic accounts, or authorized test tokens were available
for this follow-up, so those authenticated branches were not run.

## 4. What the history proves

### Confirmed timeout amplification

Before `4a2366c`, `transportRequest()` aborted after 15 seconds and `request()` retried GETs twice. A stalled initial `state` request could therefore spend approximately 30.3 seconds before surfacing an error (15 seconds + 300 ms backoff + another 15 seconds). This is a confirmed code-path explanation for the reported “more than 30 seconds” symptom when a backend request stalled. The 15-second timeout/retry behavior was present before `e61723c`, so it is not by itself evidence that `e61723c` introduced the regression.

`4a2366c` reduced the abort to 8 seconds, lowering the worst-case two-attempt GET window to about 16.3 seconds. `c21bf3b` additionally made the post-login refresh non-blocking while onboarding prompts are shown.

### Reliability changes that can add authenticated latency

`e61723c` introduced tracked admin sessions and changed request authorization to call asynchronous `isAdminSession()`:

- the top-level handler computes `adminSessionValid` for every request;
- `appState()` calls `isAdminSession()` again;
- each tracked admin validation performs a database SELECT and then a `last_seen_at` PATCH;
- player validation can perform a session SELECT/PATCH plus a player metadata SELECT;
- admin audit attribution now also uses asynchronous admin-session validation.

This is a real additional round-trip path for authenticated/admin requests. It is a plausible contributor to slow admin loads, but it was not possible to measure it without an authenticated synthetic account. It is not safe to call it the sole root cause from the available evidence.

### Weekly maintenance

Before `c21bf3b`, `appState()` awaited `ensureUpcomingEvents()` before starting the main state queries. That maintenance performs a deleted-date lookup followed by event upsert/legacy-fee maintenance. A slow Supabase request there blocked the first usable screen. The current production build starts this maintenance in the background and only waits/re-reads when the response has no expected upcoming event. This is a verified code-level improvement already present in production.

## 5. Failed-release comparison

The failed release changed 14 files (+551/-107). The highest-risk runtime changes were in `netlify/functions/api.mjs` and `public/index.html`; migrations 036/037 were additive and the service worker was unchanged from the rollback baseline.

The rollback restored the previous API/frontend behavior while retaining notification work. `5f8a3d2` reintroduced compatibility fallbacks for missing columns/tables, tracked-session logic, idempotent live-point writes, and a shell-cache bump. `4a2366c` and `c21bf3b` then reduced request timeout exposure and removed login-refresh blocking.

## 6. Service-worker findings

- `d4b9ac6`, `e61723c`, and `d6a72ce` use `bpt-shell-v2` and otherwise have the same shell/fetch strategy.
- `5f8a3d2` and current production use `bpt-shell-v3`, delete older shell caches on activation, and preserve offline fallback behavior.
- API requests bypass the service worker.
- Navigations and scripts/styles are network-first with cached fallback; this can produce a stale shell during an offline deployment, but no cache incompatibility was observed in the available live inspection.

No user storage, credentials, offline scoring queue, or PWA data was cleared.

## 7. Database compatibility

Migration 036 adds `admin_sessions`, `live_point_actions`, scorer lease columns, notification grouping, indexes, and realtime publication wiring. Migration 037 updates payment-alert templates only. The API has compatibility fallbacks for missing 036 objects/columns in several paths.

The repository shows these migrations, but production schema application was not verified in this read-only investigation. The public health check proves connectivity, not that every migration object exists. No migration was run.

## 8. Root-cause status

The evidence establishes a timeout/retry amplification mechanism and identifies authenticated session validation as a likely added cost. It does **not** establish a single, measured production bottleneck that explains every report. Current public production timings are sub-2 seconds, and authenticated browser/network timings, Supabase per-query timings, main-thread render duration, and throttled mobile timings remain unverified.

Therefore no speculative corrective code was implemented.

## 9. Smallest safe next step (not implemented)

Run the same harness with a synthetic player and admin account, capturing only duration/status/size. If that confirms the admin-session path, the smallest candidate is to validate the admin token once per request and pass that result through `appState`/authorization instead of issuing duplicate SELECT/PATCH checks. If the state query is the slow path, profile its individual Supabase queries before changing query shape or indexes.

## 10. Tests performed

- Netlify production commit/deploy verification in the authenticated Netlify dashboard.
- Public production timing harness: HTML, state (five samples), EOI state, live state, sync version, realtime config, and media state.
- `npm run check` at investigation time: all JavaScript/config checks passed and 51 automated tests passed.
- Read-only commit/diff review for the failed release, rollback, compatibility fixes, timeout fix, current production fix, service worker, and migrations.

Not performed: authenticated live testing, passkey testing, mobile throttling, main-thread profiling, Supabase schema metadata inspection, deployment, or migration.

## 12. Follow-up status

The existing harness was extended rather than replaced. It now reports whether
player/admin measurements were actually executed and supports opt-in staging
session headers while keeping credentials and response bodies out of output.
The follow-up stopped before implementation because the required isolated
staging access was unavailable. No minimal fix is justified without the
authenticated measurements requested in the brief.

## 11. Rollback procedure

No new release was created. If a future candidate is tested and causes a regression, restore the known operational rollback commit `d6a72ce476b49c79c4521ac997d25de6ebd187eb` (or the then-confirmed last-known-good commit) through the normal Netlify Git deploy workflow. Do not reset or overwrite local uncommitted work without reviewing it first.
