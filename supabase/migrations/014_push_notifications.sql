-- Browser push subscriptions are kept server-side and are only accessed by
-- Netlify Functions using the Supabase service-role key.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  preferences jsonb not null default '{"payments":true,"eoi":true,"session":true,"matches":true}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.push_notification_log (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  notification_key text not null,
  notification_type text not null,
  event_id uuid,
  sent_at timestamptz not null default now(),
  unique (subscription_id, notification_key)
);

alter table public.push_subscriptions enable row level security;
alter table public.push_notification_log enable row level security;
revoke all on table public.push_subscriptions from anon, authenticated;
revoke all on table public.push_notification_log from anon, authenticated;

create index if not exists push_subscriptions_player_active_idx
  on public.push_subscriptions (player_id, active);
create index if not exists push_notification_log_key_idx
  on public.push_notification_log (notification_key);

