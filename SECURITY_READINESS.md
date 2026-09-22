# Security and privacy readiness checklist

## Authentication and sessions

- [x] Player and administrator sessions are validated server-side.
- [x] Player/admin idle expiry and logout-all routes exist.
- [x] PIN/passkey operations are rate-limited and protected by server checks.
- [ ] Document and test the recovery process for a player who claims an unconfigured roster profile.

## Authorisation and data exposure

- [x] Service-role access stays inside Netlify functions.
- [x] Sensitive player contact data is limited to the player and administrator where required.
- [x] Media state requires an authenticated player or administrator and uses signed URLs.
- [x] Admin routes require an active administrator session.
- [ ] Add automated negative tests for every admin mutation and cross-player profile mutation.

## Notifications and privacy

- [x] Push messages now identify the relevant session instead of using generic copy.
- [x] Historical alert logs remain append-only from the user-facing workflow.
- [x] Legacy payment emails are disabled by default.
- [ ] Review lock-screen notification privacy settings before enabling amounts in push bodies for every device.

## Database and operations

- [x] Schema changes use versioned migrations.
- [x] No production migration was executed during this local pass.
- [ ] Run a tested backup/restore exercise before applying reliability migrations to production.
- [ ] Add concurrency tests for the last EOI slot, payments, live scoring and duplicate uploads.
