-- Add bounded-window and payment-speed criteria to editable badge rules.
-- The browser evaluates these rules from existing match, EOI and payment data.
alter table public.badges
  add column if not exists match_window integer,
  add column if not exists attendance_window integer,
  add column if not exists payment_within_hours numeric(6,2);

alter table public.badges
  drop constraint if exists badges_match_window_check,
  drop constraint if exists badges_attendance_window_check,
  drop constraint if exists badges_payment_within_hours_check;

alter table public.badges
  add constraint badges_match_window_check check (match_window is null or (match_window > 0 and match_window <= 100000)),
  add constraint badges_attendance_window_check check (attendance_window is null or (attendance_window > 0 and attendance_window <= 100000)),
  add constraint badges_payment_within_hours_check check (payment_within_hours is null or (payment_within_hours > 0 and payment_within_hours <= 720));

update public.badges set description='Won at least 75% of the most recent five completed matches.', min_played=5, min_wins=null, min_win_pct=75, match_window=5, fallback_type=null where name='Form King';
update public.badges set description='Attended at least four of the five most recent sessions.', min_played=null, min_attendance=4, attendance_window=5, fallback_type=null where name='Regular';
update public.badges set description='Played more than 50 completed matches.', min_played=51, min_wins=null, min_win_pct=null, match_window=null, fallback_type=null where name='Veteran';
update public.badges set description='Cleared 100% of payments within 24 hours of each session ending.', min_attendance=1, min_paid_rate=100, payment_within_hours=24, fallback_type=null where name='Paid Up Pro';
update public.badges set description='Won at least two of the five most recent completed matches.', min_played=5, min_wins=2, min_win_pct=null, match_window=5, fallback_type=null where name='Building Form';
update public.badges set description='Played at least one completed match.', min_played=1, min_wins=null, min_win_pct=null, min_attendance=null, min_paid_rate=null, match_window=null, fallback_type=null where name='Fresh Legs';
