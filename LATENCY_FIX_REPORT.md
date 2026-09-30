# Focused latency fixes — 30 September 2026

Base: `f38dd07` on `main`. No production deployment or database changes were made for this candidate.

## Verified bottlenecks and changes

- The API handler validated the admin session before dispatch, and several endpoints validated it again. Validation includes a session read and activity write. Results are now reused only within the same HTTP request; subsequent requests still verify revocation and PIN updates.
- Player validation performed independent player/PIN and session reads serially. These now start concurrently; the existing activity write remains awaited.
- State queries now start alongside authentication rather than waiting for an initial duplicate validation. Protected data remains withheld until authentication finishes.
- Every realtime live-match update scheduled a full clubhouse refresh. These updates now fetch only the existing live-state endpoint. Saved scores and other durable changes still trigger full refreshes.
- Repeat Media navigation now reuses the gallery for up to 60 seconds instead of requesting it on every visit. Existing mutations still force a reload. Responses from a previous player are discarded, and switching accounts during a request fetches the new player's gallery.
- Hidden and signed-out pages skip the existing live and EOI polls. Polling intervals are unchanged.

No authentication expiry rules, database schema, scoring rules, badge criteria, styling, service worker or dependencies were changed.

## Measurements

Signed-out production baseline from the existing `test/performance.mjs`, before any candidate deployment:

| Request | Observed elapsed time |
| --- | --- |
| HTML | 988 ms |
| State, five sequential runs | 1045, 1770, 997, 1061, 1444 ms |
| EOI state | 607 ms |
| Live state | 935 ms |
| Media state | 963 ms |

These are network-inclusive public production timings, not authenticated timings and not measurements of this candidate.

Actual before/after handler tests, with synthetic data and simulated 30 ms per database call:

| Path | Base | Candidate | Session DB calls |
| --- | --- | --- | --- |
| Admin state | 131 ms | 66 ms | 4 → 2 |
| Player badge sync | 230 ms | 97 ms | 4 → 2 |

The simulated timings verify eliminated serial work. They do not predict production latency or prove that every action is instant.

## Verification

- `npm run check`: 23 passing tests, including actual-handler revocation, PIN-change rejection, expired-session rejection, concurrent reads, request-local validation, realtime routing, hidden polling and Media account isolation.
- `git diff --check`: passed.
- Local candidate in installed Chrome at 390×844 and 1440×1000, using synthetic API responses: four-week selection, EOI request wiring, Play/Scores/Payments/Media navigation and repeat Media navigation passed; no uncaught JavaScript errors.
- Browser screenshots: `/private/tmp/bpt-latency-390.png` and `/private/tmp/bpt-latency-1440.png`.
- Browser harness: `/private/tmp/bpt-latency-browser.cjs`. All non-local requests were intercepted; no production accounts or data were used.

Unverified: real authenticated production or staging timings, actual database EOI save/reload, biometric sign-in, multi-device live-score updates and iOS PWA behavior. No isolated authenticated staging account was available.

## Release follow-up

Deploy only after approval. Measure player sign-in, admin unlock, state, EOI save, media navigation and live-point requests on desktop and mobile under the same network conditions. Verify account switching, session revocation and live finish/abandon. If the remaining delay persists, capture authenticated request waterfalls and backend timings before adding broader optimizations.

Existing untracked `PERFORMANCE_REGRESSION_REPORT.md` and `test/performance.mjs` were preserved and are not part of this change.
