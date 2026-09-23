-- Tracks the last badge state seen for each player so badge awards, removals
-- and criteria edits can produce one durable notification per transition.
create table if not exists public.player_badge_states (
  player_id uuid not null references public.players(id) on delete cascade,
  badge_key text not null,
  badge_name text not null,
  rule_version text,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (player_id, badge_key)
);

alter table public.player_badge_states enable row level security;
revoke all on public.player_badge_states from anon, authenticated;
create index if not exists player_badge_states_player_active_idx
  on public.player_badge_states (player_id, active, updated_at desc);
