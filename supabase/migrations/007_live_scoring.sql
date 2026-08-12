alter table public.match_scores
  add column if not exists points_a integer not null default 0,
  add column if not exists points_b integer not null default 0;

create table if not exists public.live_matches (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  team_a_player_ids uuid[] not null,
  team_b_player_ids uuid[] not null,
  server_player_id uuid references public.players(id),
  games_a integer not null default 0,
  games_b integer not null default 0,
  point_a integer not null default 0,
  point_b integer not null default 0,
  tiebreak_a integer not null default 0,
  tiebreak_b integer not null default 0,
  points_a integer not null default 0,
  points_b integer not null default 0,
  is_tiebreak boolean not null default false,
  completed boolean not null default false,
  created_by uuid not null references public.players(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(team_a_player_ids) = 2),
  check (cardinality(team_b_player_ids) = 2)
);

alter table public.live_matches enable row level security;

create index if not exists live_matches_event_updated_idx
  on public.live_matches (event_id, completed, updated_at desc);
