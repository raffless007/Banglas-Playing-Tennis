-- Durable one-row-per-alert history for manual and scheduled push notifications.
create table if not exists public.push_alerts (
  id uuid primary key default gen_random_uuid(),
  notification_key text not null unique,
  notification_type text not null,
  audience text,
  event_id uuid references public.events(id) on delete set null,
  title text not null,
  body text not null,
  url text,
  recipient_count integer not null default 0,
  device_count integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  status text not null default 'pending' check (status in ('pending','sent','partial','failed','no_recipients','skipped')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.push_alerts enable row level security;
revoke all on table public.push_alerts from anon, authenticated;
create index if not exists push_alerts_created_idx on public.push_alerts (created_at desc);

alter table public.push_notification_log
  add column if not exists player_id uuid references public.players(id) on delete set null,
  add column if not exists title text,
  add column if not exists body text,
  add column if not exists url text,
  add column if not exists status text not null default 'pending' check (status in ('pending','sent','failed')),
  add column if not exists error_message text,
  add column if not exists delivered_at timestamptz;

create index if not exists push_notification_log_status_idx
  on public.push_notification_log (status, sent_at desc);
