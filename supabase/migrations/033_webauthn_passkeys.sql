-- WebAuthn/passkeys for player sign-in (Face ID, Touch ID, Android biometrics,
-- Windows Hello and security keys). Private credential material is never
-- exposed through the Data API; Netlify functions use the service role.
create table if not exists public.passkeys (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  credential_id text not null unique,
  public_key text not null,
  counter bigint not null default 0,
  transports jsonb not null default '[]'::jsonb,
  friendly_name text not null default 'This device',
  device_type text,
  backed_up boolean not null default false,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists passkeys_player_idx on public.passkeys(player_id);
alter table public.passkeys enable row level security;
revoke all on public.passkeys from anon, authenticated;

create table if not exists public.webauthn_challenges (
  id uuid primary key default gen_random_uuid(),
  player_id uuid references public.players(id) on delete cascade,
  challenge_type text not null check (challenge_type in ('registration', 'authentication')),
  challenge text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists webauthn_challenges_expiry_idx
  on public.webauthn_challenges(expires_at, consumed_at);
alter table public.webauthn_challenges enable row level security;
revoke all on public.webauthn_challenges from anon, authenticated;
