-- Capacity-aware waitlists and durable in-app notifications.
create table if not exists public.player_notifications (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  event_id uuid references public.events(id) on delete set null,
  notification_type text not null default 'session',
  title text not null,
  body text not null,
  url text not null default '/?page=play',
  dedupe_key text not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (player_id, dedupe_key)
);

alter table public.player_notifications enable row level security;
revoke all on public.player_notifications from anon, authenticated;
create index if not exists player_notifications_player_read_created_idx
  on public.player_notifications (player_id, read_at, created_at desc);
