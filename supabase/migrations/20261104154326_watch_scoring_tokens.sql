-- Dedicated, revocable credentials for the Apple Watch Shortcut. Raw keys
-- are never stored; token_hash is a SHA-256 digest of a random secret.
create table if not exists public.watch_scoring_tokens (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  device_name text not null default 'Apple Watch Shortcut',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

create unique index if not exists watch_scoring_tokens_one_active_per_player
  on public.watch_scoring_tokens (player_id) where revoked_at is null;

alter table public.watch_scoring_tokens enable row level security;
revoke all on public.watch_scoring_tokens from public, anon, authenticated;
grant select, insert, update, delete on public.watch_scoring_tokens to service_role;
