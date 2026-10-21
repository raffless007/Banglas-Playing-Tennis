# Mobile-first redesign candidate

Date: 21 October 2026. Branch: `mobile-first-redesign`.

Base: `475273044b279b9b898cd9a5988ab652a581a878` (Stop reminders for deleted and cancelled events).
This report records the mobile-first candidate and the combined release candidate. The combined candidate also includes commit `2bf3814` from `scoring-reliability-fixes`: historical Admin scoring, participant score-entry deadlines, safe uncertain-save handling, persistent score drafts and profile-linked Admin access for Rafeed. The combined candidate is being prepared for the explicitly requested production release; no database migration is required.
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

The presentation layer invokes the existing app actions and adds no API endpoints or feature-specific data requests. The separately documented scoring reliability patch changes the participant manual-score deadline and grants Admin access to Rafeed's authenticated profile. It does not change badge criteria, scoring calculations or session durations. No framework or dependency was added.

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

- `npm run check`: **50 passed, 0 failed** on the combined release candidate; includes syntax/configuration, session protection, revoked PINs, media isolation, deleted-event reminders, badge rules, Singles-related protections, score reliability and performance regression tests.
- `git diff --check`: passed.
- Extracted runtime comparison: byte-equivalent after trailing whitespace normalization except the three documented edits (parallel admin reads and two leaderboard polling/render guards).
- Local preview: all six main pages at 390 px; no horizontal document overflow across the six pages at 320 px in the responsive pass. Desktop Play/Payments checked at 1440 px without document overflow.
- Four-week selector, weather expansion, synthetic EOI save/reload, Media Favorites filtering and upload disclosure verified.
- Synthetic admin unlock/session picker and timing-report copying verified.
- Synthetic Singles two-player setup, point updates and undo verified. No production match was created.
- No browser error/warning logs in the final healthy preview-tab pass.

Combined release-candidate smoke check: synthetic local preview displayed the Play page and its four-week selector at desktop and 390 px mobile width, and the Scores and Admin Scores views. Admin's closed-week score action was visible. Mobile document width measured 390 px at a 390 px viewport. Browser console showed no errors or warnings. This preview uses sample in-memory records, not production credentials or a connected database.

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

## Production release limits

Real authenticated production/staging behavior is not covered by the synthetic preview. PIN/passkey sign-in, live match lifecycle, real EOI and Admin saves, payment updates, storage uploads, installed-PWA upgrades and authenticated performance remain manual checks after deployment. The user explicitly requested production release. No Supabase migration or database write is part of this candidate. The prior known deployment is `4752730`; keep it as the rollback point and use the hosting rollback mechanism if needed.
