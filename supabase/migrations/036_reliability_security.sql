-- Reliability and security follow-up for the 14-upgrade rollout.
-- Apply after 035_player_sessions.sql.

create table if not exists public.admin_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique,
  label text not null default 'Admin browser',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists admin_sessions_active_idx on public.admin_sessions(session_id) where revoked_at is null;
alter table public.admin_sessions enable row level security;
revoke all on public.admin_sessions from anon, authenticated;

create table if not exists public.live_point_actions (
  action_id uuid primary key,
  live_match_id uuid not null references public.live_matches(id) on delete cascade,
  winner text not null check (winner in ('a','b')),
  status text not null default 'applied' check (status in ('pending','applied')),
  result jsonb,
  created_at timestamptz not null default now()
);
create index if not exists live_point_actions_match_idx on public.live_point_actions(live_match_id, created_at);
alter table public.live_point_actions enable row level security;
revoke all on public.live_point_actions from anon, authenticated;

alter table public.live_matches add column if not exists active_scorer_id uuid references public.players(id) on delete set null;
alter table public.live_matches add column if not exists scorer_lease_until timestamptz;
create index if not exists live_matches_scorer_idx on public.live_matches(active_scorer_id, scorer_lease_until);

alter table public.player_notifications add column if not exists group_key text;
create index if not exists player_notifications_group_idx on public.player_notifications(player_id, group_key, created_at desc);

do $$
begin
  begin alter publication supabase_realtime add table public.live_point_actions; exception when duplicate_object then null; when undefined_object then null; end;
end $$;
