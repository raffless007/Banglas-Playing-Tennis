-- Add an upper win bound so badges can express streak-style negative criteria.
alter table public.badges
  add column if not exists max_wins integer;

alter table public.badges
  drop constraint if exists badges_max_wins_check;

alter table public.badges
  add constraint badges_max_wins_check
  check (max_wins is null or (max_wins >= 0 and max_wins <= 100000));

update public.badges
set max_wins = null,
    updated_at = now()
where name in ('Form King', 'Regular', 'Point Machine', 'Veteran', 'Paid Up Pro', 'Building Form', 'Fresh Legs');

insert into public.badges
  (name, description, min_played, min_wins, max_wins, min_win_pct, min_attendance, min_point_diff, min_paid_rate, match_window, attendance_window, payment_within_hours, fallback_type, sort_order)
values
  ('Legend', 'Played at least 50 completed matches and has at least a 70% win rate.', 50, null, null, 70, null, null, null, null, null, null, null, 60),
  ('Disgrace', 'Lost all five of the most recent completed matches.', 5, null, 0, null, null, null, null, 5, null, null, null, 70)
on conflict (name) do update set
  description = excluded.description,
  min_played = excluded.min_played,
  min_wins = excluded.min_wins,
  max_wins = excluded.max_wins,
  min_win_pct = excluded.min_win_pct,
  min_attendance = excluded.min_attendance,
  min_point_diff = excluded.min_point_diff,
  min_paid_rate = excluded.min_paid_rate,
  match_window = excluded.match_window,
  attendance_window = excluded.attendance_window,
  payment_within_hours = excluded.payment_within_hours,
  fallback_type = excluded.fallback_type,
  sort_order = excluded.sort_order,
  enabled = true,
  updated_at = now();
