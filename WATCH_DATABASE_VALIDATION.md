# Watch database validation

## Phase 4 update

- The restricted `watch-score` handler and profile key controls are implemented on this development branch. Valid, expired, revoked, replaced and inactive-owner keys, participant scope, compact state, point/undo/tiebreak/finish, version conflicts and idempotent retries are exercised through the real Netlify handler against synthetic local PostgreSQL records in `test/watch-phone-equivalence.test.mjs`.
- A phone-point versus Watch-point race is tested by pausing the Watch at its version-conditional database write, allowing the phone point to commit, and verifying the stale Watch action conflicts and its pending action record is removed.
- The previous public `live-state` and `eoi-state` endpoints now require a normal authenticated session. Phone polling uses the same intervals, sends an admin session where needed and does not update session last-seen timestamps. Signed-out roster responses omit email/mobile. This security hardening adds session-validation reads to polling and needs production performance monitoring; it was tested locally, not on a physical device.
- Final local results: 74 application checks, 76 pgTAP assertions, 3 real-handler integration tests and three separate player/Watch/admin race-and-rollback runs passed. An isolated esbuild bundle and JavaScript syntax check also passed. See `WATCH_RELEASE_CHECKLIST.md` for the small-sample local latency measurements and precise rollout cautions.
- No additional database migration was created in Phase 4. Database tests use the same three local draft migrations. Device/Shortcut execution, real push delivery and production schema compatibility are not verified. See `WATCH_RELEASE_CHECKLIST.md` and `APPLE_WATCH_SHORTCUT_SETUP.md`.

## Phase 3 continuation (historical; superseded by Phase 4)

- The draft RPC signature is now `finalize_live_match_atomic(uuid, integer, uuid, text)`. The service-only caller mode differentiates attending phone players, participating Watch players and server-verified admin calls. Saved-result retries are checked against the persisted event/teams. The phone backend now derives the mode from the verified session and uses this RPC; Watch API/token validation remains unimplemented.
- Local checks passed: 76 pgTAP assertions; 12 real-Postgres old-phone/RPC persistence comparisons and integrated phone API cases; and independent-connection race/rollback runs for player, watch and admin modes. The original 72 application checks passed. Details, measured local latency and limitations are in `WATCH_PHONE_FINISH_INTEGRATION.md`.
- Production constraints remain unverified and no production migration or deployment occurred. The earlier Phase 3 notes below describe the state before this continuation.

## Phase 3 update (historical; superseded by Phase 4)

- Local-only additive migration `20261104163549_allow_singles_score_teams.sql` removes the two legacy named doubles-only score constraints while retaining the format-aware team-size constraint. Synthetic local tests cover allowed singles and rejected malformed teams. No production migration was applied; production constraint state remains unverified.
- Local pgTAP now passes **63 assertions**, including ten synthetic source-to-RPC mapping checks for doubles and singles regular/tiebreak results. The independent-connection race/rollback suite passes again. These tests do not directly execute the existing phone finish path, so they do not establish phone/RPC equivalence.
- Phone integration is intentionally blocked: the current phone finish allows an attending nonparticipant and a verified admin to finish a match, while the RPC requires the submitter to be a participant. See `WATCH_PHONE_FINISH_INTEGRATION.md`. The old phone finish path remains unchanged. No latency comparison was run.

## Local environment and baseline

- Docker Desktop 29.9.2 responded in `desktop-linux`; no Colima was installed.
- Supabase CLI 3.0.0 started an isolated stack named `bpt-watch-shortcuts`; PostgreSQL reports 17.11. No remote project was linked and no production database was contacted.
- The repository migration chain starts with `001_add_scores.sql`, which assumes existing players and events. Git commit `58fddf7` contains an early schema predating the chain. Its schema-only portion was reconstructed in `/private/tmp/bpt-watch-db-validation/bootstrap.sql`; its real player and settings seeds were deliberately omitted.
- The complete migration chain was copied to `/private/tmp/bpt-watch-db-validation/supabase/migrations`, alongside a local-only `000_local_bootstrap.sql`. The CLI offers no dry-run for local `migration up`. The reviewed copies were applied locally, then the local database was reset with `--no-seed` and the corrected full copied chain reapplied from scratch. No historical repository migration was edited. The temporary bootstrap is not a production migration and must not be deployed.
- Both Watch migrations, `20261104154326_watch_scoring_tokens.sql` and `20261104154844_atomic_live_match_finish.sql`, applied to the local stack only. The latter was corrected after a test exposed a duration integer overflow when the synthetic start date was in the future; clamping now occurs before integer conversion.

## Actual results

- `supabase test db`: **49 pgTAP assertions passed**, in `supabase/tests/watch_database_structure.sql` and `supabase/tests/watch_database_behavior.sql`, using synthetic records. Tests cover token hash uniqueness, replacement history, source-ID backfill and null legacy IDs, direct role privileges, RLS enabled, service-role execution, stale/unfinished/unresolved-tiebreak/unauthorized rejection, saving, source ID survival, duplicate source rejection and idempotent retry. The tests verify several saved score fields; they do not constitute a full field-by-field comparison with the existing phone implementation.
- `BPT_LOCAL_DOCKER_TEST=1 node --test test/watch-postgres-races.test.mjs`: **1 suite passed** against independent `psql` connections inside the local container. It demonstrated a finalization transaction blocking a version-conditional update until deletion committed, an update winning first causing conflict, concurrent finalizations yielding saved/already-saved with one score, a retry after cleanup, and rollback when a test-only delete trigger raised an exception after insertion.
- `finalize_live_match_atomic(uuid, integer, uuid)` is `SECURITY INVOKER` with an empty search path. `SELECT ... FOR UPDATE` holds the live-match row lock while checking the expected version and creating the historical score. The immutable `source_live_match_id` survives the existing `ON DELETE SET NULL` foreign key, and retry after cleanup found the original score. pgTAP checked that anon/authenticated lack execute permission and the service role can execute it.
- Local Supabase security advisor: **no issues found**. Local database lint reported a pre-existing `public.record_player_pin_failure` error: ambiguous `pin_locked_at` reference (SQLSTATE 42702). This unrelated function was not changed.
- Fresh historical migration replay also retains the old `match_scores_team_a_exactly_two` and `match_scores_team_b_exactly_two` constraints alongside the later singles constraint. This is a pre-existing migration-chain discrepancy that can reject singles scores in a fresh replay; it was not silently corrected or attributed to the Watch migrations.
- `npm run check`: **72/72 passed**. `git diff --check` passed for tracked changes. The race suite is opt-in and was run separately with the explicit local Docker flag.

## Remaining limits

- The pgTAP and concurrency tests use synthetic data and a reconstructed historical base, not a production schema snapshot. Production constraint state, browser/device UI, physical Shortcuts behavior and real push delivery remain unverified.
- The per-token/IP rate limits are in-process, per server instance. A point action whose idempotency record remains pending after a failure must be reconciled by a fresh state request; do not blindly retry a new point. In-flight requests can complete while a key is being revoked.
- Local test containers remain running. Do not promote the temporary bootstrap to production. Do not deploy or apply the Watch migrations until production inspection, preview/device testing and release approval are complete. Production remained unchanged.
