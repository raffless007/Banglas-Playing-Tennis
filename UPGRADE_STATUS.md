# Upgrade status

Last reviewed: 23 September 2026 (Australia/Sydney)

## Current phase

Phase 1 complete; Phase 2–7 are being delivered incrementally. This package is release-ready for the reviewed Netlify workflow. The Supabase production database has not been changed by this upgrade pass; migrations remain explicit release steps.

## Completed in this pass

- Audited the existing HTML/CSS/JavaScript, Netlify functions, service worker, Supabase migrations and automated checks.
- Preserved existing uncommitted work; no reset or destructive Git operation was performed.
- Made system-generated notifications specific: session date, venue, court/time details, payment context, EOI deadline, waitlist position, cancellation reason/context and weather probability are included where relevant.
- Added runtime context to custom scheduled payment alerts and updated the built-in payment-alert templates through migration `037_specific_notification_copy.sql`.
- Added event context to admin-sent alerts when a week is selected and fixed their notification-key reuse so the inbox and push log refer to the same alert.
- Removed the service-worker’s vague push fallback; malformed push payloads are ignored rather than shown as a generic update.
- Disabled the legacy payment-email function by default. It now requires the explicit `ENABLE_EMAIL_REMINDERS=true` environment setting, while push reminders remain separate.
- Removed the insecure hard-coded administrator passcode fallback; first-time admin setup now requires a valid `INITIAL_ADMIN_PASSCODE` secret.
- Added rate limiting to first-time player PIN status/setup requests to reduce unauthorised profile-claim attempts without resetting existing PINs.
- Corrected the Play screen copy to Men’s doubles, updated the visible media quota to 5 GB, and raised baseline touch-target sizing while preserving the existing responsive layout.
- Removed the runtime `$52 → $54` fee rewrite; new events use the schema default, while an organiser’s deliberate historical/custom fee is never silently overwritten.
- Preserved an existing event/player payment amount when a payment is re-confirmed, so historical charges do not change after later event-fee edits.
- Kept the canonical `supabase/schema.sql` aligned with the new reliability tables, scorer lease fields, notification grouping and specific payment-alert defaults.
- Hardened the service worker to ignore malformed push payloads safely and to route valid notification clicks to the requested in-app page.
- Added automated coverage for notification specificity and deferred email behaviour.

## Existing protections verified during the audit

- Server-side player/admin session validation and idle expiry.
- PIN/passkey routes and rate-limit protections.
- Server-side player identity checks for player actions.
- Live-score idempotency and optimistic concurrency checks.
- Media access gating and signed media URLs.
- Security headers and service-worker update behaviour.

## Remaining work

- Complete the visual-system and mobile layout review across every screen with representative device testing.
- Extract the largest frontend/backend areas into small modules only where tests demonstrate a safe boundary.
- Expand business-rule tests for concurrent last-place EOIs, fee rounding, payment integrity, media permissions and session recovery.
- Verify the deferred email function is not scheduled in the connected Netlify site before any release.
- Apply migrations only after review and explicit production approval.

## Known limitations

- Already-sent push alerts and historical inbox entries are intentionally not rewritten; audit history preserves the original copy.
- A manually authored alert without a selected event has no session context to attach. Event-scoped manual alerts are contextualized automatically.
- No staging Supabase project was available in this local workspace, so database migrations are prepared but not executed.
