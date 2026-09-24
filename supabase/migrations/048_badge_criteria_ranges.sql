-- Add optional upper bounds so the badge editor can express clear ranges.
alter table public.badges
  add column if not exists max_win_pct numeric(5,2),
  add column if not exists max_attendance integer,
  add column if not exists max_point_diff integer,
  add column if not exists max_paid_rate numeric(5,2);

alter table public.badges
  drop constraint if exists badges_max_win_pct_check,
  drop constraint if exists badges_max_attendance_check,
  drop constraint if exists badges_max_point_diff_check,
  drop constraint if exists badges_max_paid_rate_check,
  drop constraint if exists badges_min_max_win_pct_check,
  drop constraint if exists badges_min_max_attendance_check,
  drop constraint if exists badges_min_max_point_diff_check,
  drop constraint if exists badges_min_max_paid_rate_check;

alter table public.badges
  add constraint badges_max_win_pct_check check (max_win_pct is null or (max_win_pct >= 0 and max_win_pct <= 100)),
  add constraint badges_max_attendance_check check (max_attendance is null or (max_attendance >= 0 and max_attendance <= 100000)),
  add constraint badges_max_point_diff_check check (max_point_diff is null or (max_point_diff >= -100000 and max_point_diff <= 100000)),
  add constraint badges_max_paid_rate_check check (max_paid_rate is null or (max_paid_rate >= 0 and max_paid_rate <= 100)),
  add constraint badges_min_max_win_pct_check check (min_win_pct is null or max_win_pct is null or max_win_pct >= min_win_pct),
  add constraint badges_min_max_attendance_check check (min_attendance is null or max_attendance is null or max_attendance >= min_attendance),
  add constraint badges_min_max_point_diff_check check (min_point_diff is null or max_point_diff is null or max_point_diff >= min_point_diff),
  add constraint badges_min_max_paid_rate_check check (min_paid_rate is null or max_paid_rate is null or max_paid_rate >= min_paid_rate);
