-- Isolated player sessions make the same profile safe to use on multiple
-- devices. Each login receives its own server-tracked session record; one
-- device never overwrites another device's token.
create table if not exists public.player_sessions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  session_id uuid not null unique,
  device_label text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists player_sessions_player_idx on public.player_sessions(player_id, last_seen_at desc);
create index if not exists player_sessions_active_idx on public.player_sessions(session_id) where revoked_at is null;
alter table public.player_sessions enable row level security;
revoke all on public.player_sessions from anon, authenticated;
