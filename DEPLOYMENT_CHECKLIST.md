# Deployment checklist

## Files in this upgrade package

- `netlify/functions/api.mjs`, `netlify/functions/push-reminders.mjs`, and `netlify/functions/reminders.mjs`
- `public/index.html` and `public/sw.js`
- `supabase/schema.sql`, `supabase/migrations/036_reliability_security.sql`, and `supabase/migrations/037_specific_notification_copy.sql`
- `.env.example`, `test/config.test.mjs`, `UPGRADE_STATUS.md`, `CHANGELOG.md`, and `SECURITY_READINESS.md`

The working tree also contains earlier uncommitted application improvements. Review the full diff before selecting a release commit.

## Before deployment

- Review the complete working-tree diff, including prior uncommitted changes.
- Run `npm run check` and `git diff --check`.
- Review migration order and confirm the target Supabase project is the intended project.
- Apply migrations in order, including `036_reliability_security.sql` and `037_specific_notification_copy.sql`, only with explicit production approval.
- Confirm `ENABLE_EMAIL_REMINDERS` is not set to `true`; payment reminders are push-only by design.
- Confirm VAPID and Supabase server environment variables are configured in Netlify without exposing their values.
- Confirm the legacy `reminders` function is not scheduled. The scheduled push function is `push-reminders`.

## Deploy

1. Use the reviewed branch/commit only.
2. Deploy the Netlify preview first when available.
3. Smoke-test login, player switching, EOI, waitlist, payment, scoring, media, notifications and admin flows.
4. Obtain explicit approval before publishing to production.

## Post-deployment verification

- Open the app in a fresh browser and verify the service worker updates to the current shell.
- Test a session update, EOI deadline alert, payment reminder, waitlist action, cancellation and event-scoped manual alert.
- Confirm notification titles and bodies contain the relevant date and venue.
- Confirm push delivery and in-app notification inbox entries use the same notification key.
- Confirm an unauthenticated request cannot read private state or media.
- Confirm no payment email is sent and push reminders still run.
- Check the Netlify function logs and Supabase audit/alert logs for errors.

## Rollback

- Revert the application deployment to the last known-good commit.
- Do not delete historical data or reverse an applied migration automatically.
- If migration rollback is required, prepare and review a targeted compensating migration against a backup first.
- Preserve alert and audit logs for diagnosis.
