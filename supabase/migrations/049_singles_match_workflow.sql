-- Allow individual scored matches to be Singles while preserving Doubles as the default.
alter table public.match_scores
  add column if not exists match_type text not null default 'doubles',
  add column if not exists games_to_win integer not null default 4;

alter table public.live_matches
  add column if not exists match_type text not null default 'doubles',
  add column if not exists games_to_win integer not null default 4;

alter table public.match_scores
  drop constraint if exists match_scores_team_a_player_ids_check,
  drop constraint if exists match_scores_team_b_player_ids_check,
  drop constraint if exists match_scores_match_type_check,
  drop constraint if exists match_scores_match_type_players_check,
  drop constraint if exists match_scores_games_to_win_check,
  add constraint match_scores_match_type_check check (match_type in ('doubles','singles')),
  add constraint match_scores_games_to_win_check check (games_to_win in (2,4)),
  add constraint match_scores_team_a_player_ids_check check (cardinality(team_a_player_ids) between 1 and 2),
  add constraint match_scores_team_b_player_ids_check check (cardinality(team_b_player_ids) between 1 and 2),
  add constraint match_scores_match_type_players_check check ((match_type = 'singles' and cardinality(team_a_player_ids) = 1 and cardinality(team_b_player_ids) = 1) or (match_type = 'doubles' and games_to_win = 4 and cardinality(team_a_player_ids) = 2 and cardinality(team_b_player_ids) = 2));

alter table public.live_matches
  drop constraint if exists live_matches_team_a_player_ids_check,
  drop constraint if exists live_matches_team_b_player_ids_check,
  drop constraint if exists live_matches_match_type_check,
  drop constraint if exists live_matches_match_type_players_check,
  drop constraint if exists live_matches_games_to_win_check,
  add constraint live_matches_match_type_check check (match_type in ('doubles','singles')),
  add constraint live_matches_games_to_win_check check (games_to_win in (2,4)),
  add constraint live_matches_team_a_player_ids_check check (cardinality(team_a_player_ids) between 1 and 2),
  add constraint live_matches_team_b_player_ids_check check (cardinality(team_b_player_ids) between 1 and 2),
  add constraint live_matches_match_type_players_check check ((match_type = 'singles' and cardinality(team_a_player_ids) = 1 and cardinality(team_b_player_ids) = 1) or (match_type = 'doubles' and games_to_win = 4 and cardinality(team_a_player_ids) = 2 and cardinality(team_b_player_ids) = 2));

update public.match_scores set match_type = 'doubles' where match_type is null;
update public.live_matches set match_type = 'doubles' where match_type is null;
