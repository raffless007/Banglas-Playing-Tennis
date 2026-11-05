# Watch scoring: review and release checklist

**No production queries, migrations or deployment were run for this feature.** This branch is for review/device testing, not proof of production readiness. Run the following queries only after separate authorization, against the intended production project in a read-only session. They do not change data.

```sql
-- Relevant tables and columns.
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name in ('watch_scoring_tokens','match_scores','live_matches')
order by table_name, ordinal_position;

-- Existing constraints, including legacy doubles-only checks and the FK.
select c.conrelid::regclass as table_name,c.conname,pg_get_constraintdef(c.oid) as definition
from pg_constraint c
where c.conrelid in ('public.match_scores'::regclass,'public.live_matches'::regclass)
order by 1,2;

-- Indexes, including source ID and active-token uniqueness.
select tablename,indexname,indexdef from pg_indexes
where schemaname='public' and tablename in ('match_scores','live_matches','watch_scoring_tokens')
order by tablename,indexname;

-- Existing finalization signatures and security mode.
select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef as security_definer,p.proconfig
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='finalize_live_match_atomic';

-- Recorded migration history; naming/version conventions may differ from filenames.
select version,name from supabase_migrations.schema_migrations order by version;
```

Compare results with the local test report, especially `match_scores_team_a_exactly_two` and `match_scores_team_b_exactly_two`. The local replay needed the singles constraint fix; production may already differ. Review any existing same-named table, column, function or index rather than assuming an `IF NOT EXISTS` migration matches it. Verify the function is executable only by the intended server-side role and the token table denies PUBLIC/anon/authenticated access.

## Before release

1. Review the complete diff, migration order, security model, role grants, idempotency and local test output. Verify the production database backup and a rollback owner.
2. Run the read-only checks above with approval; resolve any schema/history differences. Do not apply the local temporary bootstrap.
3. On an isolated preview/staging environment, apply in timestamp order: `20261104154326_watch_scoring_tokens.sql`, `20261104154844_atomic_live_match_finish.sql`, and `20261104163549_allow_singles_score_teams.sql`, after confirming each is appropriate to that environment. The atomic migration backfills only existing non-null `live_match_id` values.
4. Run Node checks, pgTAP, real multi-connection races, phone/Watch handler integration and a Netlify build. Test the exact Shortcut on a physical iPhone and Apple Watch: fresh login/key, both teams' points, duplicate tap, Undo, 3–3 selection for 5 and 7, completion, Save & End, retry, stale score, airplane mode/reconnect, key revocation and phone sync. Verify actual push notification delivery. Test a signed-out roster and authenticated profile after the contact-privacy change.
5. Schedule production migration and app deployment together only after explicit approval. The backend depends on the new four-argument RPC; deploying backend code before its migration will break Save & End. Old cached phone clients that do not send `expectedVersion` cannot save against the new backend until refreshed. Plan communication/service-worker refresh and avoid switching releases during an active match.
6. After release, verify production health, authenticated/unauthenticated access, function logs with no credentials, scoring on test data where authorized, and the exact deployed commit. Do not perform destructive tests against real matches.

## Credential and API notes

Watch keys contain 256 random bits; the database stores SHA-256 hashes, not raw keys. A key is owner-bound, revocable and restricted to live scoring. The token is supplied only in `X-Watch-Token`, never in the URL. Replacing it revokes prior active keys. A key in a Shortcut Text action is not Keychain-protected; never share it.

`POST /.netlify/functions/api?action=watch-score` accepts `state`, `team_a_plus`, `team_b_plus`, `undo`, `tiebreak_5`, `tiebreak_7`, and `finish`. Every mutation requires `matchId` and numeric `expectedVersion`; points also require the previously returned `nextActionId`. The API derives player identity and Watch mode server-side. Point/undo/tiebreak use the existing version-conditional scoring helpers; finalization uses the service-only atomic RPC and durable `source_live_match_id`. An ordinary stale state returns HTTP 200 with `conflict=true` and refreshed compact state. Authentication failures are HTTP 401/403; malformed requests 400; rate limiting 429; unexpected failures 503. An uncertain point must be followed by an explicit refresh, not a blind retry with a new action ID.

Rate limits are in-process and per-server-instance, not a globally distributed abuse barrier. Review production platform protections and logs before treating them as a comprehensive rate limit. Watch response times and Shortcut compatibility must be measured on actual devices/networks.

The existing `live-state` and `eoi-state` polling endpoints now require a normal player or admin session; a Watch key alone cannot read them. Signed-out `state` responses no longer include email or mobile. The phone's existing polling intervals are unchanged, but each authenticated poll performs session validation; it deliberately does not update last-seen timestamps or keep an idle session alive. A local tracked-player live poll took 8.1 ms and 3 database requests in one synthetic sample; this is not a production measurement. Older cached admin-only clients may need a refresh to send their admin session for polling. The service-worker shell version was bumped for the shared score formatter.

Latest local synthetic handler timings (not production, very small samples): state median 15.5 ms / slowest 20.4 ms (8); point 41.7 / 66.8 ms (5); undo 44.4 / 44.4 ms (2); tiebreak 26.4 / 26.4 ms (2); finish 37.3 / 37.3 ms (2). Values include local API/database interactions, not Watch, mobile network or real push delivery. Point action records are created and finalized in separate operations; if a failure leaves a pending action, the safe response is to refresh and review the authoritative score, not to blindly retry with a new action ID. An already in-flight authorized request may complete while its key is being revoked.

## Rollback

Do not roll back only the frontend while leaving an incompatible backend or vice versa. Coordinate the application and server rollback to a compatible version, retain both Watch token and historical score data, and do not automatically drop RPCs or columns. The pre-change backend cannot reliably find a just-saved result by the new durable `source_live_match_id` after its old FK has been cleared; test and communicate retry behavior during rollback. Any schema reversal requires a separately reviewed compensating migration and backup; do not delete live matches or historical scores automatically. Revoke an exposed key through the owner's profile, or use an explicitly authorized administrative procedure.
