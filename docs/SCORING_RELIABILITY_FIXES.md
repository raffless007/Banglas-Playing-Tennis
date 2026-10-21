# Scoring, save reliability and profile-linked Admin

21 October 2026. Branch: `scoring-reliability-fixes`. Base: production code `475273044b279b9b898cd9a5988ab652a581a878`.

This branch does not include the mobile redesign (`186b591`, preserved on `mobile-first-redesign`). No deployment, production data mutation or Supabase migration was performed. No schema change is required.

## Investigation

### Shadeed's missing result

Read-only production audit records show repeated failed `score` submissions by Shadeed on 14 October, during the session. The games were **3–3**, with tie-break entries including **7–3** and **5–2**. Shadeed was on that event's final In list. The existing validator rejected 3–3 because it required the final set score, 4–3. The previous audit records recorded only `failed`, not the rejection reason; the payload and validator reproduce the rejection in isolated tests.

The candidate accepts 3–3 plus a valid winning tie-break and normalizes it to 4–3. It still rejects incomplete/invalid tie-breaks. Singles race-to-2 retains its existing 2–2 tie-break representation. Invalid or empty game scores remain rejected. Drafts are retained locally until the server acknowledges the save.

No historical result was recreated: the attempts contain different tie-break totals and do not establish which was the actual result. An admin can enter the correct result after release.

### Eight-second failures

The production client aborted every API call after 8 seconds. The backend awaited post-write audit reads/inserts; event edits also waited for notification creation and push delivery. Consequently, an already-committed mutation could miss the browser deadline and appear to fail until refresh. Admin's follow-up state reloads were serial and a failed reload was presented as a failed save.

These are confirmed code-level failure paths, not a claim that every reported timeout has the same cause. Read-only Supabase HTTP logs and earlier database measurements were inspected; actual authenticated end-to-end production timing and the deployment's function region are still unverified. No promise of universally instant network operations is made.

## Changes

1. Admin → Scores includes **Add scores for this week**. This opens the existing completed-match form for the selected week. Authenticated Admin can add/correct scores without a time/attendance restriction; roster and valid-score checks still apply. Closed weeks remain closed for payments.
2. Participants can enter completed results from the session's start until the exact start of the next non-deleted, non-cancelled event. Venue timezones/DST and an earlier second-court start are respected. No known next event means no artificial 24-hour cutoff. Attendance checks remain mandatory. Existing live scoring has its separate match-day window; this change does not reopen old live matches for participants.
3. Completed-result normalization, double-click prevention, locally retained per-profile/per-week drafts, and stable submission identifiers. Deterministic server-generated row IDs and conflict-ignore inserts make an unchanged retry idempotent without a migration. Existing score corrections remain updates, not reinsertions.
4. GET timeout is 20 seconds; writes have 30 seconds. Writes are **not automatically retried**. An unknown network outcome is labelled unconfirmed rather than definitely failed. EOI performs a read-back on an ambiguous response; confirmed writes are not reverted. Ordinary rejected writes still roll back the optimistic EOI display. Duplicate concurrent EOI submissions from the same page are blocked.
5. EOI uses one event-attendance read instead of separate existing-player/current-list/waitlist reads. Audit and notification delivery use Netlify `context.waitUntil` after the durable write; an older/local runtime without that method awaits the task instead of discarding it. Second-court waitlist promotion remains in the primary business operation. See [Netlify's Functions API](https://docs.netlify.com/build/functions/api/).
6. Admin reloads run concurrently after acknowledgement; a failed follow-up refresh is explicitly distinguished from a failed save. Event/score responses update the local record immediately when available. Numeric save duration is exposed in `Server-Timing`. New audit failures include a reason/status; audit insert failures remain logged on the server.
7. Rafeed's verified immutable roster ID is the server-side profile/Admin binding. Admin displays **Continue with my Admin profile**, requiring no separate Admin PIN. The endpoint validates the signed player session, active account, PIN reset/revocation state and allowlist before issuing a tracked Admin session. Linked Admin credentials require that same player's valid session on every Admin request. Existing one-hour Admin idle expiry/manual lock remains. Other profiles cannot grant themselves access through a name change or a cached UI flag.

`ADMIN_PLAYER_IDS` can override the server allowlist; setting it to an empty value disables profile-linked Admin. The default binds only Rafeed's verified existing ID. No client-editable role field is trusted. Shared Admin PIN access remains available as before.

## Verification

- `npm run check`: **45 tests passed, 0 failed**.
- `git diff --check`: passed.
- Actual handler tests use synthetic DB/auth boundaries: participant deadline boundary, cancelled/deleted weeks, timezone/second-court opening, Admin add/update of old closed weeks, nonparticipant rejection, unauthorized Admin rejection, 3–3 normalization, invalid tie-breaks, Singles race-to-2, idempotent retries, post-write audit completion and EOI read reduction.
- Linked-Admin tests cover a different player, missing authentication, revoked session, PIN reset and one-hour idle expiry.
- Client tests cover uncertain writes, credential forwarding, draft retention/retry identity, EOI reconciliation and venue-time deadlines.
- Local browser used actual candidate HTML/JS with synthetic in-memory APIs: profile unlock, Admin historical-week selection, adding a 3–3/5–2 result to a closed week (displayed as 4–3), participant manual-entry availability after 24 hours, hidden old live controls and draft recovery after reload. No console errors/warnings in the browser pass.
- Screenshot: `docs/scoring-reliability/admin-closed-week.jpg` (synthetic records, not production).

## Unverified / release checks

Real authenticated production performance, live hosting `waitUntil` completion, actual mobile installed-PWA upgrade, push delivery after backgrounding, and writes against an isolated staging database still require deployment-preview/staging checks. The local browser uses fake credentials; it does not test real PIN/passkey authentication or write any real player's records.

Review the permission change deliberately: anyone who can authenticate as Rafeed now gains full Admin access through that profile. The explicit server allowlist and normal session revocation checks reduce accidental privilege exposure, but do not remove the risk the user accepted.

Before release, verify save latency and background task logs using an isolated account, then test actual PIN/passkey login, Admin unlock/lock/expiry, EOI toggles on a slow connection, score retry after a dropped response, and draft recovery. Do not deploy the redesign with these fixes unless separately approved.

## Files

`.env.example`, `netlify/functions/api.mjs`, `public/index.html`, `public/js/scoring-reliability.js`, `public/sw.js`, `package.json`, `test/config.test.mjs`, `test/latency.test.mjs`, `test/scoring-reliability.test.mjs`, `scripts/preview-scoring-fixes.mjs`, this report and its screenshot.

Local preview: `node scripts/preview-scoring-fixes.mjs`, then <http://127.0.0.1:4174/>. All changes in that preview stay in process memory. Production and Supabase were not modified.
