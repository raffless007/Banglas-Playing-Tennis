# Changelog

## 23 September 2026 — compatibility reapplication prepared locally

- Reimplemented the failed reliability pass on top of the known-good runtime rather than restoring its incompatible startup/UI changes wholesale.
- Added loader recovery, legacy-admin-token compatibility, optional admin session tracking, idempotent live-point retries, per-player offline queues and five-minute background version polling.
- Preserved historical payment amounts and corrected weekly recap player totals.
- Bumped the service-worker shell cache and added checks for the new compatibility paths.
- Local only; no Netlify deployment was performed.

## 23 September 2026 — rollback to known-good runtime

- Rolled the application runtime back to `d4b9ac6` after the later reliability release caused an app-loading regression.
- Retained the notification-specific changes and the already-applied Supabase migrations; no database rollback was performed.

## 23 September 2026 — notification and safety pass

- Reworked automatic notification titles and bodies to identify the relevant session instead of using generic copy.
- Added exact EOI deadline timestamps and venue details to deadline alerts.
- Added date, venue and court details to payment, waitlist, cancellation, weather and session-change alerts.
- Added event context to admin manual alerts when an event is selected.
- Updated stored payment schedule templates with migration `037_specific_notification_copy.sql`.
- Disabled legacy email payment reminders by default with an explicit opt-in guard.
- Removed the service worker’s generic push-message fallback.
- Made malformed push payloads no-ops and kept notification clicks routed to their requested app page.
- Preserved historical payment amounts when an existing payment is re-confirmed after an event fee edit.
- Updated the canonical Supabase schema with the reliability tables/columns and contextual notification defaults used by the new migrations.
- Applied migrations `036_reliability_security.sql` and `037_specific_notification_copy.sql` to the production Supabase project and verified the resulting schema and alert schedules.
- Added tests covering notification context and deferred email behaviour.

## Earlier local work retained

This working tree also contains previously prepared authentication, live-scoring reliability, media privacy, notification inbox, profile and admin improvements. They remain uncommitted and are intentionally preserved for the next review/deployment decision.
