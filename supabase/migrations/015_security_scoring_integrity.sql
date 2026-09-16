-- Login lockout and concurrency safeguards.
alter table public.players
  add column if not exists pin_failed_attempts integer not null default 0,
  add column if not exists pin_locked_at timestamptz;

update public.players
set pin_failed_attempts = 0
where pin_failed_attempts is null;

alter table public.live_matches
  add column if not exists version integer not null default 0,
  add column if not exists started_at timestamptz,
  add column if not exists ended_at timestamptz,
  add column if not exists duration_seconds integer;

alter table public.match_scores
  add column if not exists live_match_id uuid references public.live_matches(id),
  add column if not exists started_at timestamptz,
  add column if not exists ended_at timestamptz,
  add column if not exists duration_seconds integer;

create unique index if not exists live_matches_one_active_per_event_idx
  on public.live_matches (event_id)
  where completed = false;

create unique index if not exists match_scores_live_match_id_unique
  on public.match_scores (live_match_id)
  where live_match_id is not null;

create or replace function public.record_player_pin_failure(target_player_id uuid)
returns table(failed_attempts integer, pin_locked_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.players
  set pin_failed_attempts = least(coalesce(pin_failed_attempts, 0) + 1, 5),
      pin_locked_at = case
        when coalesce(pin_failed_attempts, 0) + 1 >= 5 then coalesce(pin_locked_at, now())
        else pin_locked_at
      end
  where id = target_player_id
    and active = true
  returning public.players.pin_failed_attempts, public.players.pin_locked_at;
end;
$$;

revoke all on function public.record_player_pin_failure(uuid) from public, anon, authenticated;
grant execute on function public.record_player_pin_failure(uuid) to service_role;
