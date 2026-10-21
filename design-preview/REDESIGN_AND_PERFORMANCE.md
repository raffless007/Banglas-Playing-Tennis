# Mobile-first redesign candidate

Date: 21 October 2026. Branch: `mobile-first-redesign`.

Base: `475273044b279b9b898cd9a5988ab652a581a878` (Stop reminders for deleted and cancelled events).
This is a local candidate, not a production release. No production deploy, database mutation or migration was performed.
The pre-existing untracked `PERFORMANCE_REGRESSION_REPORT.md` and `test/performance.mjs` were preserved and are not part of this change.

## Review the actual candidate

Run `node scripts/preview-redesign.mjs` from this directory, then open <http://127.0.0.1:4173/>.
The server binds only to loopback and serves the actual candidate assets with synthetic, in-memory API responses. It does not connect to production. Restarting the server resets its records. The local admin test PIN is `0000`; it is not a real credential.

Open <http://127.0.0.1:4173/preview/overview> for the mobile screenshot overview. The preview substitutes simple court graphics and sample records; these are not production photographs or results. Browser device emulation is not an actual iPhone test.

## Visual and interaction changes

- Consistent green/cream branding, compact headings, readable labels and mobile inputs.
- Fixed six-item icon-and-label mobile navigation with safe-area spacing. Desktop retains its header navigation.
- Play: readable four-week cards, compact session/court/location details, small inline entry PIN, clear EOI choices, collapsed weather details, six quick shortcuts.
- Scores: compact results and recap, expandable scoring rules and completed-match entry, live controls prioritized on mobile, appropriate Singles point labels.
- Profiles: readable mobile player cards and responsive profile dialogs; existing stats and badges retained.
- Payments: amount/status first, three compact tracker totals and readable player payment timestamps.
- Media: gallery-first layout, upload form available through an explicit Upload button, existing Favorites tab, compact controls.
- Admin: mobile session dropdown instead of a long left-hand event list; existing desktop list/editor layout retained. Existing forms and dashboard tabs restyled.
- Admin Settings: Copy timing report for recent local request/render diagnostics. No telemetry is uploaded.

Existing business rules, badge criteria, scoring calculations, authentication rules and session durations were not changed. The presentation layer invokes existing actions and adds no API endpoints or data requests. No framework or dependency was added.

## Performance changes

1. Extract the existing script and all 13 original style blocks into reusable browser assets, preserving source order. HTML is now 9,801 bytes instead of 375,487 bytes (97.4% smaller HTML document). This is **not** a 97% reduction in the total cold application download: the original code still downloads as assets, and the new presentation layer adds bytes. Benefit is cache reuse and a smaller document on subsequent navigations.
2. Signed-out state requests fetch only the roster rather than querying private history and running weekly-event maintenance.
3. Start avatar URL signing when roster data arrives, concurrently with the remaining state queries.
4. Avoid redundant weekly-event maintenance when the expected upcoming weeks already exist; retain existing handling for missing and deliberately deleted sessions.
5. After an admin save, load app/admin state concurrently rather than serially.
6. Do not poll live-match state or rerender the leaderboard for live-only updates while the leaderboard is visible. Active live scoring retains its existing cadence and realtime behavior.
7. Add numeric `Server-Timing` stages and an in-memory, 60-entry client timing report. Reports omit request bodies, headers, credentials, player identifiers and profile details. Render timings measure synchronous renderer execution, not browser paint/layout.
8. Update the service-worker shell asset list and version so the extracted assets are available to the existing shell strategy. No API response caching was added.

### Measurements and limits

| Measurement | Baseline | Candidate | Conditions |
| --- | ---: | ---: | --- |
| HTML document size | 375,487 B | 9,801 B | Local source byte count; not total transferred app bytes |
| State with slow score read + avatar signing | 191 ms | 110 ms | Same synthetic 100 ms score read / 80 ms storage fixtures |
| Avatar signing starts after score read begins | 102 ms | 6 ms | Same synthetic fixture |

The existing test suite also reports comparisons against earlier latency fixtures. Those are synthetic tests, not current authenticated production benchmarks.

Read-only signed-out **production baseline**, using the existing performance script: HTML 122 ms; state samples 2,295 / 975 / 1,066 / 1,040 / 992 ms; EOI 505 ms; live state 519 ms; sync version 533 ms; realtime configuration 828 ms; media state 285 ms. These measurements describe production `4752730`, **not the local candidate**. No production before/after improvement is claimed.

Read-only database diagnostics found small tables and sampled mean SQL SELECT execution times generally below 1 ms. This does not measure HTTP round trips, connection overhead, authentication or Storage signing. It does not support blaming large history tables for the observed multi-second lag.

The database is in Sydney. Verify the deployed Netlify function region before release; a region mismatch has **not** been established. See [Netlify's function region configuration](https://docs.netlify.com/build/functions/configuration/). No region change was made blindly.

## Verification

- `npm run check`: **37 passed, 0 failed**; includes syntax/configuration, session protection, revoked PINs, media isolation, deleted-event reminders, badge rules, Singles-related existing protections and new performance regression tests.
- `git diff --check`: passed.
- Extracted runtime comparison: byte-equivalent after trailing whitespace normalization except the three documented edits (parallel admin reads and two leaderboard polling/render guards).
- Local preview: all six main pages at 390 px; no horizontal document overflow across the six pages at 320 px in the responsive pass. Desktop Play/Payments checked at 1440 px without document overflow.
- Four-week selector, weather expansion, synthetic EOI save/reload, Media Favorites filtering and upload disclosure verified.
- Synthetic admin unlock/session picker and timing-report copying verified.
- Synthetic Singles two-player setup, point updates and undo verified. No production match was created.
- No browser error/warning logs in the final healthy preview-tab pass.

### Not verified / release gates

- **Real authenticated production or isolated staging latency is not measured.** Local synthetic sign-in is not validation of real authentication.
- Actual EOI/payment/scoring writes against an isolated database, real passkeys, multi-device sessions, Google Places, push delivery, file uploads and clipboard image behavior require staging/manual coverage.
- Abandon-match confirmation could not be completed because the browser automation stalled at the confirmation dialog. The earlier point/undo test succeeded. Retest abandon/finish and score persistence before release.
- Offline/PWA upgrade behavior and actual iOS/Android installed-app rendering are unverified; preview intentionally disables service-worker registration and external connections.
- Local render timings were sub-4 ms in sampled synchronous calls, but do not establish server latency or perceived paint speed.

Do not promise every network-backed action is instant. The next release gate is an authenticated trace: distinguish PIN verification, session validation, state query, Storage and rendering time using the new timing report and browser Network panel.

## Changed files

- `public/index.html`: mechanically extracted shell; asset references.
- `public/css/app.css`: original styles in original order.
- `public/css/mobile-first.css`: new responsive visual layer.
- `public/js/app.js`: original runtime with the three documented performance edits.
- `public/js/mobile-first.js`: presentation/disclosure/shortcut enhancements.
- `public/js/performance.js`: private local timing instrumentation.
- `public/sw.js`: new shell assets/cache version.
- `netlify/functions/api.mjs`: state-path performance work and timing headers.
- `package.json`, `test/config.test.mjs`, `test/latency.test.mjs`: syntax and regression coverage.
- `scripts/extract-shell.mjs`: guarded one-time mechanical extraction utility.
- `scripts/preview-redesign.mjs`: isolated synthetic preview server.
- `design-preview/overview.html`, `design-preview/local-ui-timings.json`, this report and `design-preview/screenshots/*.jpg`: review artifacts.

## Safe release sequence (not performed)

1. Review these screenshots and the complete branch diff. Keep this branch isolated from unrelated work.
2. Deploy a non-production preview with isolated synthetic accounts/database; do not exercise writes on production records.
3. Verify real sign-in/reopen/expiry, EOI save/reload, admin save, Singles/Doubles start/point/undo/abandon/finish, payment confirmation/timestamps, media and offline upgrade.
4. Capture identical authenticated mobile/desktop traces before/after, including warm/cold paths. Check actual function region and investigate any remaining dominant server stage.
5. Release only after those checks and user approval. No migration is needed for this candidate. Keep `4752730` as the known baseline rollback; use the hosting rollback mechanism if necessary rather than resetting unrelated local work.

No production/Supabase changes were made during this task.
