alter table public.push_alerts
  add column if not exists recipient_ids jsonb not null default '[]'::jsonb;
