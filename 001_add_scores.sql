-- Run this file in Supabase SQL Editor only if the original database was
-- created before the Scores feature was added.

create table if not exists public.match_scores (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  team_a_player_ids uuid[] not null,
  team_b_player_ids uuid[] not null,
  games_a integer not null check (games_a between 0 and 4),
  games_b integer not null check (games_b between 0 and 4),
  tiebreak_a integer,
  tiebreak_b integer,
  submitted_by uuid not null references public.players(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(team_a_player_ids) = 2),
  check (cardinality(team_b_player_ids) = 2)
);

alter table public.match_scores enable row level security;

-- Tighten an earlier Scores table, if present, from optional singles/doubles
-- to doubles-only. Existing valid doubles rows remain untouched.
alter table public.match_scores
  drop constraint if exists match_scores_team_a_exactly_two,
  drop constraint if exists match_scores_team_b_exactly_two;

alter table public.match_scores
  add constraint match_scores_team_a_exactly_two check (cardinality(team_a_player_ids) = 2),
  add constraint match_scores_team_b_exactly_two check (cardinality(team_b_player_ids) = 2);

create index if not exists match_scores_event_created_idx
  on public.match_scores (event_id, created_at);
