alter table public.match_scores
  add column if not exists tiebreak_to_win integer not null default 5;

alter table public.match_scores
  drop constraint if exists match_scores_tiebreak_to_win_check,
  add constraint match_scores_tiebreak_to_win_check check (tiebreak_to_win in (5, 7));

alter table public.live_matches
  add column if not exists tiebreak_to_win integer not null default 5,
  add column if not exists needs_tiebreak_choice boolean not null default false;

alter table public.live_matches
  drop constraint if exists live_matches_tiebreak_to_win_check,
  add constraint live_matches_tiebreak_to_win_check check (tiebreak_to_win in (5, 7));
