-- Keep the initial badge set aligned with the editable Admin badge rules.
-- This is idempotent so it can safely repair environments that previously
-- received the editor schema without the requested badge preset values.

update public.badges
set description = 'Won at least 75% of the most recent five completed matches.',
    min_played = 5, min_wins = null, max_wins = null, min_win_pct = 75,
    min_attendance = null, min_paid_rate = null, match_window = 5,
    attendance_window = null, payment_within_hours = null,
    fallback_type = null, enabled = true, updated_at = now()
where name = 'Form King';

update public.badges
set description = 'Attended at least four of the five most recent completed sessions.',
    min_played = null, min_wins = null, max_wins = null, min_win_pct = null,
    min_attendance = 4, min_paid_rate = null, match_window = null,
    attendance_window = 5, payment_within_hours = null,
    fallback_type = null, enabled = true, updated_at = now()
where name = 'Regular';

update public.badges
set description = 'Played more than 50 completed matches.',
    min_played = 51, min_wins = null, max_wins = null, min_win_pct = null,
    min_attendance = null, min_paid_rate = null, match_window = null,
    attendance_window = null, payment_within_hours = null,
    fallback_type = null, enabled = true, updated_at = now()
where name = 'Veteran';

update public.badges
set description = 'Cleared 100% of payments within 24 hours of each session ending.',
    min_played = null, min_wins = null, max_wins = null, min_win_pct = null,
    min_attendance = 1, min_paid_rate = 100, match_window = null,
    attendance_window = null, payment_within_hours = 24,
    fallback_type = null, enabled = true, updated_at = now()
where name = 'Paid Up Pro';

update public.badges
set description = 'Won at least two of the five most recent completed matches.',
    min_played = 5, min_wins = 2, max_wins = null, min_win_pct = null,
    min_attendance = null, min_paid_rate = null, match_window = 5,
    attendance_window = null, payment_within_hours = null,
    fallback_type = null, enabled = true, updated_at = now()
where name = 'Building Form';

update public.badges
set description = 'Played at least one completed match.',
    min_played = 1, min_wins = null, max_wins = null, min_win_pct = null,
    min_attendance = null, min_paid_rate = null, match_window = null,
    attendance_window = null, payment_within_hours = null,
    fallback_type = null, enabled = true, updated_at = now()
where name = 'Fresh Legs';

update public.badges
set description = 'Lost all five of the most recent completed matches.',
    min_played = 5, min_wins = null, max_wins = 0, min_win_pct = null,
    min_attendance = null, min_paid_rate = null, match_window = 5,
    attendance_window = null, payment_within_hours = null,
    fallback_type = null, enabled = true, updated_at = now()
where name = 'Disgrace';
