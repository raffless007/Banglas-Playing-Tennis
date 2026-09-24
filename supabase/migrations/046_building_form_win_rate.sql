-- Building Form is a 40% win-rate badge over the latest five matches.
-- Form King takes precedence when both rules would otherwise qualify.
update public.badges
set description = 'Won at least 40% of the most recent five completed matches.',
    min_played = 5,
    min_wins = null,
    max_wins = null,
    min_win_pct = 40,
    match_window = 5,
    updated_at = now()
where name = 'Building Form';
