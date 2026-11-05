-- Migration 001 added these named doubles-only checks. Migration 049 added
-- the format-aware constraint but did not remove these older restrictions.
-- Keep match_scores_match_type_players_check to validate both formats.
alter table public.match_scores
  drop constraint if exists match_scores_team_a_exactly_two,
  drop constraint if exists match_scores_team_b_exactly_two;
