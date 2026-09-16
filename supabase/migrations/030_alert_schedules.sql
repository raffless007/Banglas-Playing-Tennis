-- Editable schedules used by the hourly push-reminder function.
create table if not exists public.push_alert_schedules (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  notification_type text not null default 'payments',
  delay_minutes integer not null default 0 check (delay_minutes >= 0),
  repeat_interval_minutes integer check (repeat_interval_minutes is null or repeat_interval_minutes > 0),
  title_template text not null default 'Tennis payment reminder',
  body_template text not null default '{date}: ${amount} is still outstanding. PayID {payid}.',
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_alert_schedules_type_check check (notification_type in ('payments','eoi','session','matches'))
);

alter table public.push_alert_schedules enable row level security;
revoke all on table public.push_alert_schedules from anon, authenticated;

insert into public.push_alert_schedules
  (code, name, notification_type, delay_minutes, repeat_interval_minutes, title_template, body_template, sort_order)
values
  ('payment-30m', '30 minutes after session completion', 'payments', 30, null,
   'Payment is now open', '{date}: ${amount} is due. Payment PayID: {payid}.', 10),
  ('payment-12h', '12 hours after session completion', 'payments', 720, null,
   'Payment reminder', '{date}: ${amount} is still outstanding. Payment PayID: {payid}.', 20),
  ('payment-36h', '36 hours after session completion', 'payments', 2160, null,
   'Payment reminder', '{date}: ${amount} is still outstanding. Payment PayID: {payid}.', 30),
  ('payment-daily', 'Every 24 hours until paid', 'payments', 3600, 1440,
   'Payment reminder', '{date}: ${amount} is still outstanding. Payment PayID: {payid}.', 40)
on conflict (code) do nothing;

create index if not exists push_alert_schedules_enabled_idx
  on public.push_alert_schedules (enabled, sort_order);
