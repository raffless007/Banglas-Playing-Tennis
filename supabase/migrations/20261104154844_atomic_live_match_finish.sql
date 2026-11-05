-- Keep the live-match identity after ON DELETE SET NULL removes the FK.
alter table public.match_scores add column if not exists source_live_match_id uuid;
update public.match_scores set source_live_match_id = live_match_id
  where source_live_match_id is null and live_match_id is not null;
create unique index if not exists match_scores_source_live_match_id_unique
  on public.match_scores(source_live_match_id) where source_live_match_id is not null;

-- Runs as the service role only. Each call is a single database transaction;
-- the row lock serializes finalization with point and undo updates.
drop function if exists public.finalize_live_match_atomic(uuid, integer, uuid);
create or replace function public.finalize_live_match_atomic(
  p_match_id uuid, p_expected_version integer, p_submitted_by uuid, p_caller_mode text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  m public.live_matches%rowtype;
  s public.match_scores%rowtype;
  finished_at timestamptz := now();
begin
  if p_match_id is null or p_expected_version is null or p_submitted_by is null or p_caller_mode is null or p_caller_mode not in ('player', 'watch', 'admin') then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into s from public.match_scores where source_live_match_id = p_match_id;
  if found then
    if not exists (select 1 from public.players where id = p_submitted_by)
      or (p_caller_mode <> 'admin' and not exists (select 1 from public.eois where event_id = s.event_id and player_id = p_submitted_by and status = 'yes' and waitlist_position is null))
      or (p_caller_mode = 'watch' and not (p_submitted_by = any(s.team_a_player_ids) or p_submitted_by = any(s.team_b_player_ids))) then
      return jsonb_build_object('status', 'forbidden');
    end if;
    return jsonb_build_object('status', 'already_saved', 'score', to_jsonb(s));
  end if;

  select * into m from public.live_matches where id = p_match_id for update;
  if not found then
    select * into s from public.match_scores where source_live_match_id = p_match_id;
    if found then
      if not exists (select 1 from public.players where id = p_submitted_by)
        or (p_caller_mode <> 'admin' and not exists (select 1 from public.eois where event_id = s.event_id and player_id = p_submitted_by and status = 'yes' and waitlist_position is null))
        or (p_caller_mode = 'watch' and not (p_submitted_by = any(s.team_a_player_ids) or p_submitted_by = any(s.team_b_player_ids))) then
        return jsonb_build_object('status', 'forbidden');
      end if;
      return jsonb_build_object('status', 'already_saved', 'score', to_jsonb(s));
    end if;
    return jsonb_build_object('status', 'not_found');
  end if;
  if not exists (select 1 from public.players where id = p_submitted_by)
    or (p_caller_mode <> 'admin' and not exists (select 1 from public.eois where event_id = m.event_id and player_id = p_submitted_by and status = 'yes' and waitlist_position is null))
    or (p_caller_mode = 'watch' and not (p_submitted_by = any(m.team_a_player_ids) or p_submitted_by = any(m.team_b_player_ids))) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if m.version is distinct from p_expected_version then
    return jsonb_build_object('status', 'conflict');
  end if;
  if not m.completed or m.needs_tiebreak_choice then
    return jsonb_build_object('status', 'unfinished');
  end if;

  insert into public.match_scores (
    event_id, match_type, games_to_win, tiebreak_to_win, team_a_player_ids,
    team_b_player_ids, games_a, games_b, tiebreak_a, tiebreak_b, points_a,
    points_b, submitted_by, live_match_id, source_live_match_id, started_at,
    ended_at, duration_seconds
  ) values (
    m.event_id, m.match_type, m.games_to_win, m.tiebreak_to_win,
    m.team_a_player_ids, m.team_b_player_ids, m.games_a, m.games_b,
    case when m.is_tiebreak then m.tiebreak_a else null end,
    case when m.is_tiebreak then m.tiebreak_b else null end,
    m.points_a, m.points_b, p_submitted_by, m.id, m.id,
    coalesce(m.started_at, m.created_at), finished_at,
    least(2147483647, greatest(0, round(extract(epoch from finished_at - coalesce(m.started_at, m.created_at)))))::integer
  ) returning * into s;

  delete from public.live_matches where id = m.id;
  select * into s from public.match_scores where id = s.id;
  return jsonb_build_object('status', 'saved', 'score', to_jsonb(s));
end;
$$;

revoke all on function public.finalize_live_match_atomic(uuid, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.finalize_live_match_atomic(uuid, integer, uuid, text) to service_role;
