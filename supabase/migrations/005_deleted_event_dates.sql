create table if not exists public.deleted_event_dates (
  event_date date primary key,
  deleted_at timestamptz not null default now()
);

alter table public.deleted_event_dates enable row level security;
