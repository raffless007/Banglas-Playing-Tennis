-- Keep the editable badge criteria and badge-award notifications in sync with
-- the deployed badge editor. All statements are safe to re-run.
alter table public.badges
  add column if not exists match_window integer,
  add column if not exists attendance_window integer,
  add column if not exists payment_within_hours numeric(6,2),
  add column if not exists max_wins integer;

alter table public.badges
  drop constraint if exists badges_match_window_check,
  drop constraint if exists badges_attendance_window_check,
  drop constraint if exists badges_payment_within_hours_check,
  drop constraint if exists badges_max_wins_check;

alter table public.badges
  add constraint badges_match_window_check
    check (match_window is null or (match_window > 0 and match_window <= 100000)),
  add constraint badges_attendance_window_check
    check (attendance_window is null or (attendance_window > 0 and attendance_window <= 100000)),
  add constraint badges_payment_within_hours_check
    check (payment_within_hours is null or (payment_within_hours > 0 and payment_within_hours <= 720)),
  add constraint badges_max_wins_check
    check (max_wins is null or (max_wins >= 0 and max_wins <= 100000));

insert into public.badges
  (name, description, min_played, min_wins, max_wins, min_win_pct, min_attendance, min_point_diff, min_paid_rate, match_window, attendance_window, payment_within_hours, fallback_type, sort_order)
values
  ('Legend', 'Played at least 50 completed matches and has at least a 70% win rate.', 50, null, null, 70, null, null, null, null, null, null, null, 60),
  ('Disgrace', 'Lost all five of the most recent completed matches.', 5, null, 0, null, null, null, null, null, 5, null, null, 70)
on conflict (name) do update set
  description=excluded.description,
  min_played=excluded.min_played,
  min_wins=excluded.min_wins,
  max_wins=excluded.max_wins,
  min_win_pct=excluded.min_win_pct,
  min_attendance=excluded.min_attendance,
  min_point_diff=excluded.min_point_diff,
  min_paid_rate=excluded.min_paid_rate,
  match_window=excluded.match_window,
  attendance_window=excluded.attendance_window,
  payment_within_hours=excluded.payment_within_hours,
  fallback_type=excluded.fallback_type,
  sort_order=excluded.sort_order,
  enabled=true,
  updated_at=now();

create table if not exists public.player_badge_states (
  player_id uuid not null references public.players(id) on delete cascade,
  badge_key text not null,
  badge_name text not null,
  rule_version text,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (player_id, badge_key)
);

alter table public.player_badge_states enable row level security;
revoke all on table public.player_badge_states from anon, authenticated;
create index if not exists player_badge_states_player_active_idx
  on public.player_badge_states (player_id, active, updated_at desc);
