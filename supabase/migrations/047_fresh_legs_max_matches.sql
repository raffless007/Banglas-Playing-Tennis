-- Bound Fresh Legs to players who have played between one and five matches.
-- The maximum is an editable badge criterion, so future badges can use it too.
alter table public.badges
  add column if not exists max_played integer;

alter table public.badges
  drop constraint if exists badges_max_played_check;

alter table public.badges
  add constraint badges_max_played_check
  check (max_played is null or (max_played >= 0 and max_played <= 100000));

update public.badges
set description = 'Played between one and five completed matches.',
    min_played = 1,
    max_played = 5,
    min_wins = null,
    max_wins = null,
    min_win_pct = null,
    min_attendance = null,
    min_point_diff = null,
    min_paid_rate = null,
    match_window = null,
    attendance_window = null,
    payment_within_hours = null,
    fallback_type = null,
    enabled = true,
    updated_at = now()
where name = 'Fresh Legs';
