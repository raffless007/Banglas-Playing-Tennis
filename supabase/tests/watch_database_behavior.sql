begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(59);
insert into public.players(id,name) values
 ('10000000-0000-4000-8000-000000000001','Synthetic DB A'),
 ('10000000-0000-4000-8000-000000000002','Synthetic DB B'),
 ('10000000-0000-4000-8000-000000000003','Synthetic DB C'),
 ('10000000-0000-4000-8000-000000000004','Synthetic DB D'),
 ('10000000-0000-4000-8000-000000000005','Synthetic DB outsider'),
 ('10000000-0000-4000-8000-000000000006','Synthetic DB attending scorer'),
 ('10000000-0000-4000-8000-000000000007','Synthetic DB waitlisted'),
 ('10000000-0000-4000-8000-000000000008','Synthetic DB out');
insert into public.events(id,event_date) values ('20000000-0000-4000-8000-000000000001','2099-01-01');
insert into public.eois(event_id,player_id,status,waitlist_position) values
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','yes',null),
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','yes',null),
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','yes',null),
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000004','yes',null),
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000006','yes',null),
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000007','yes',1),
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000008','no',null);
insert into public.live_matches(id,event_id,team_a_player_ids,team_b_player_ids,created_by,games_a,games_b,points_a,points_b,completed,version,started_at)
values ('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
 array['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002']::uuid[],
 array['10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000004']::uuid[],
 '10000000-0000-4000-8000-000000000001',4,2,24,18,true,5,'2099-01-01 00:00:00+00');
insert into public.match_scores(event_id,team_a_player_ids,team_b_player_ids,games_a,games_b,submitted_by,live_match_id)
select event_id,team_a_player_ids,team_b_player_ids,games_a,games_b,created_by,id from public.live_matches where id='30000000-0000-4000-8000-000000000001';
insert into public.match_scores(event_id,team_a_player_ids,team_b_player_ids,games_a,games_b,submitted_by)
select event_id,team_a_player_ids,team_b_player_ids,games_a,games_b,created_by from public.live_matches where id='30000000-0000-4000-8000-000000000001';
update public.match_scores set source_live_match_id=live_match_id where source_live_match_id is null and live_match_id is not null;
select is((select count(*)::int from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'),1,'backfill copies existing live ID');
select is((select count(*)::int from public.match_scores where event_id='20000000-0000-4000-8000-000000000001' and live_match_id is null and source_live_match_id is null),1,'backfill does not invent legacy ID');
delete from public.match_scores where event_id='20000000-0000-4000-8000-000000000001';
insert into public.watch_scoring_tokens(player_id,token_hash,expires_at) values ('10000000-0000-4000-8000-000000000001',repeat('a',64),'2099-01-01 00:00:00+00');
select is((select expires_at::text from public.watch_scoring_tokens where token_hash=repeat('a',64)), '2099-01-01 00:00:00+00', 'expiry stored');
select throws_ok($$insert into public.watch_scoring_tokens(player_id,token_hash) values ('10000000-0000-4000-8000-000000000002',repeat('a',64))$$,'23505',null,'duplicate token hash rejected');
update public.watch_scoring_tokens set revoked_at=now() where token_hash=repeat('a',64);
insert into public.watch_scoring_tokens(player_id,token_hash) values ('10000000-0000-4000-8000-000000000001',repeat('b',64));
select ok((select revoked_at is not null from public.watch_scoring_tokens where token_hash=repeat('a',64)), 'old token remains revoked');
select is((select count(*)::int from public.watch_scoring_tokens where player_id='10000000-0000-4000-8000-000000000001'),2,'replacement keeps history');
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000001',5,'10000000-0000-4000-8000-000000000005', 'watch')->>'status','forbidden','outsider cannot finalize');
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000001',5,'10000000-0000-4000-8000-000000000005','player')->>'status','forbidden','nonattending phone player rejected');
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000001',5,'10000000-0000-4000-8000-000000000007','player')->>'status','forbidden','waitlisted player rejected');
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000001',5,'10000000-0000-4000-8000-000000000008','player')->>'status','forbidden','out player rejected');
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000001',5,'10000000-0000-4000-8000-000000000006','watch')->>'status','forbidden','watch attending nonparticipant rejected');
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000001',5,'10000000-0000-4000-8000-000000000001','unknown')->>'status','invalid','unknown caller mode rejected');
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000001',4,'10000000-0000-4000-8000-000000000001', 'watch')->>'status','conflict','stale version rejected');
select is((select count(*)::int from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'),0,'conflict saves nothing');
select is((select count(*)::int from public.live_matches where id='30000000-0000-4000-8000-000000000001'),1,'conflict leaves live match');
update public.live_matches set completed=false where id='30000000-0000-4000-8000-000000000001';
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000001',5,'10000000-0000-4000-8000-000000000001', 'watch')->>'status','unfinished','unfinished match rejected');
update public.live_matches set completed=true,needs_tiebreak_choice=true where id='30000000-0000-4000-8000-000000000001';
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000001',5,'10000000-0000-4000-8000-000000000001', 'watch')->>'status','unfinished','unresolved tiebreak rejected');
update public.live_matches set needs_tiebreak_choice=false where id='30000000-0000-4000-8000-000000000001';
set local role service_role;
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000001',5,'10000000-0000-4000-8000-000000000001', 'watch')->>'status','saved','service role saves for valid participant');
reset role;
select is((select count(*)::int from public.live_matches where id='30000000-0000-4000-8000-000000000001'),0,'live match removed');
select is((select count(*)::int from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'),1,'source ID survives cleanup');
select ok((select live_match_id is null from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'),'live-match foreign key cleared');
select is((select games_a from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'),4,'games A saved');
select is((select games_b from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'),2,'games B saved');
select is((select points_a from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'),24,'points A saved');
select is((select points_b from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'),18,'points B saved');
select is((select match_type from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'),'doubles','match type preserved');
select is((select games_to_win from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'),4,'games target preserved');
select is((select tiebreak_to_win from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'),5,'tiebreak target preserved');
select is((select cardinality(team_a_player_ids)+cardinality(team_b_player_ids) from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'),4,'both teams preserved');
select is((select submitted_by::text from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'),'10000000-0000-4000-8000-000000000001','submitter preserved');
select is((select started_at::text from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'),'2099-01-01 00:00:00+00','start time preserved');
select is((select duration_seconds from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'),0,'future start duration clamps to zero');
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000001',5,'10000000-0000-4000-8000-000000000001', 'watch')->>'status','already_saved','retry is idempotent');
select is((select count(*)::int from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'),1,'retry makes no duplicate');
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000001',5,'10000000-0000-4000-8000-000000000005', 'watch')->>'status','forbidden','outsider cannot fetch saved match');
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000001',5,'10000000-0000-4000-8000-000000000006','player')->>'status','already_saved','attending nonparticipant may retry');
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000001',5,'10000000-0000-4000-8000-000000000006','watch')->>'status','forbidden','watch nonparticipant cannot read retry');
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000001',5,'10000000-0000-4000-8000-000000000005','admin')->>'status','already_saved','trusted admin can retry');
select throws_ok($$insert into public.match_scores(event_id,team_a_player_ids,team_b_player_ids,games_a,games_b,submitted_by,source_live_match_id) select event_id,team_a_player_ids,team_b_player_ids,games_a,games_b,submitted_by,source_live_match_id from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'$$,'23505',null,'duplicate source ID rejected');
select lives_ok($$insert into public.match_scores(event_id,team_a_player_ids,team_b_player_ids,games_a,games_b,submitted_by) select event_id,team_a_player_ids,team_b_player_ids,games_a,games_b,submitted_by from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000001'$$,'legacy null source ID allowed');
select lives_ok($$insert into public.match_scores(event_id,match_type,games_to_win,team_a_player_ids,team_b_player_ids,games_a,games_b,submitted_by) values ('20000000-0000-4000-8000-000000000001','singles',2,array['10000000-0000-4000-8000-000000000001']::uuid[],array['10000000-0000-4000-8000-000000000003']::uuid[],2,0,'10000000-0000-4000-8000-000000000001')$$,'singles one player per side accepted');
select throws_ok($$insert into public.match_scores(event_id,match_type,team_a_player_ids,team_b_player_ids,games_a,games_b,submitted_by) values ('20000000-0000-4000-8000-000000000001','doubles',array['10000000-0000-4000-8000-000000000001']::uuid[],array['10000000-0000-4000-8000-000000000003']::uuid[],4,1,'10000000-0000-4000-8000-000000000001')$$,'23514',null,'doubles with one player per side rejected');
select throws_ok($$insert into public.match_scores(event_id,match_type,team_a_player_ids,team_b_player_ids,games_a,games_b,submitted_by) values ('20000000-0000-4000-8000-000000000001','singles',array['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002']::uuid[],array['10000000-0000-4000-8000-000000000003']::uuid[],4,1,'10000000-0000-4000-8000-000000000001')$$,'23514',null,'singles with two players per side rejected');
insert into public.live_matches(id,event_id,match_type,games_to_win,team_a_player_ids,team_b_player_ids,created_by,games_a,games_b,completed,version) values ('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','singles',2,array['10000000-0000-4000-8000-000000000001']::uuid[],array['10000000-0000-4000-8000-000000000003']::uuid[],'10000000-0000-4000-8000-000000000001',3,1,true,1);
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000002',1,'10000000-0000-4000-8000-000000000001', 'watch')->>'status','saved','singles finalization stores score');
insert into public.live_matches(id,event_id,match_type,games_to_win,team_a_player_ids,team_b_player_ids,created_by,games_a,games_b,completed,version) values ('30000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','singles',2,array['10000000-0000-4000-8000-000000000001']::uuid[],array['10000000-0000-4000-8000-000000000003']::uuid[],'10000000-0000-4000-8000-000000000001',2,0,true,1);
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000003',1,'10000000-0000-4000-8000-000000000006','player')->>'status','saved','attending nonparticipant can save');
select is((select submitted_by::text from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000003'),'10000000-0000-4000-8000-000000000006','nonparticipant submitter preserved');
insert into public.live_matches(id,event_id,match_type,games_to_win,team_a_player_ids,team_b_player_ids,created_by,games_a,games_b,completed,version) values ('30000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000001','singles',2,array['10000000-0000-4000-8000-000000000001']::uuid[],array['10000000-0000-4000-8000-000000000003']::uuid[],'10000000-0000-4000-8000-000000000001',2,0,true,1);
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000004',1,'10000000-0000-4000-8000-000000000005','admin')->>'status','saved','trusted admin nonparticipant can save');
-- Check the RPC mapping against each synthetic source row. This is not a
-- substitute for invoking the existing phone endpoint in an integration test.
create function pg_temp.check_finish_mapping(fmt text, target int, ga int, gb int, tie boolean, ta int, tb int, tie_target int) returns boolean language plpgsql as $$
declare m public.live_matches%rowtype; result jsonb; s jsonb;
begin
  insert into public.live_matches(event_id,match_type,games_to_win,tiebreak_to_win,team_a_player_ids,team_b_player_ids,created_by,games_a,games_b,tiebreak_a,tiebreak_b,is_tiebreak,points_a,points_b,completed,version,started_at)
  values ('20000000-0000-4000-8000-000000000001',fmt,target,tie_target,
    case when fmt='doubles' then array['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002']::uuid[] else array['10000000-0000-4000-8000-000000000001']::uuid[] end,
    case when fmt='doubles' then array['10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000004']::uuid[] else array['10000000-0000-4000-8000-000000000003']::uuid[] end,
    '10000000-0000-4000-8000-000000000001',ga,gb,coalesce(ta,0),coalesce(tb,0),tie,24,18,true,7,now()-interval '4 minutes') returning * into m;
  result := public.finalize_live_match_atomic(m.id,7,m.created_by, 'watch'); s := result->'score';
  return result->>'status'='saved' and (s->>'source_live_match_id')::uuid=m.id
    and (s->>'event_id')::uuid=m.event_id and s->>'match_type'=m.match_type
    and (s->>'games_to_win')::int=m.games_to_win and (s->>'tiebreak_to_win')::int=m.tiebreak_to_win
    and s->'team_a_player_ids'=to_jsonb(m.team_a_player_ids) and s->'team_b_player_ids'=to_jsonb(m.team_b_player_ids)
    and (s->>'games_a')::int=m.games_a and (s->>'games_b')::int=m.games_b
    and (s->>'tiebreak_a')::int is not distinct from case when tie then m.tiebreak_a else null end
    and (s->>'tiebreak_b')::int is not distinct from case when tie then m.tiebreak_b else null end
    and (s->>'points_a')::int=m.points_a and (s->>'points_b')::int=m.points_b
    and (s->>'submitted_by')::uuid=m.created_by and (s->>'started_at')::timestamptz=m.started_at
    and (s->>'ended_at')::timestamptz=now() and (s->>'duration_seconds')::int=240;
end $$;
select ok(pg_temp.check_finish_mapping('doubles',4,4,0,false,null,null,5),'doubles 4–0 mapping');
select ok(pg_temp.check_finish_mapping('doubles',4,4,1,false,null,null,5),'doubles 4–1 mapping');
select ok(pg_temp.check_finish_mapping('doubles',4,4,2,false,null,null,5),'doubles 4–2 mapping');
select ok(pg_temp.check_finish_mapping('doubles',4,4,3,true,5,3,5),'doubles 5-point tiebreak mapping');
select ok(pg_temp.check_finish_mapping('doubles',4,4,3,true,7,5,7),'doubles 7-point tiebreak mapping');
select ok(pg_temp.check_finish_mapping('singles',4,4,2,false,null,null,5),'singles race to 4 mapping');
select ok(pg_temp.check_finish_mapping('singles',2,2,0,false,null,null,5),'singles 2–0 mapping');
select ok(pg_temp.check_finish_mapping('singles',2,3,1,false,null,null,5),'singles 3–1 mapping');
select ok(pg_temp.check_finish_mapping('singles',2,2,2,true,5,3,5),'singles 5-point tiebreak mapping');
select ok(pg_temp.check_finish_mapping('singles',2,2,2,true,7,5,7),'singles 7-point tiebreak mapping');
insert into public.live_matches(id,event_id,match_type,games_to_win,team_a_player_ids,team_b_player_ids,created_by,games_a,games_b,completed,version,started_at) values ('30000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000001','singles',2,array['10000000-0000-4000-8000-000000000001']::uuid[],array['10000000-0000-4000-8000-000000000003']::uuid[],'10000000-0000-4000-8000-000000000001',2,0,true,1,'1900-01-01 00:00:00+00');
select is(public.finalize_live_match_atomic('30000000-0000-4000-8000-000000000005',1,'10000000-0000-4000-8000-000000000001','watch')->>'status','saved','very old start does not overflow');
select is((select duration_seconds from public.match_scores where source_live_match_id='30000000-0000-4000-8000-000000000005'),2147483647,'very long duration clamps to integer maximum');
select * from finish();
rollback;
