-- Reusable court locations with event-level snapshots and overrides.
create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  suburb text not null default '',
  entry_pin text,
  court_1_fee numeric(10,2) not null default 54.00,
  court_2_fee numeric(10,2) not null default 0.00,
  ball_fee numeric(10,2) not null default 1.00,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name, suburb)
);

alter table public.events
  add column if not exists location_id uuid references public.locations(id) on delete set null,
  add column if not exists entry_pin text;

create index if not exists locations_active_name_idx
  on public.locations (active, name, suburb);
create index if not exists events_location_idx
  on public.events (location_id);

-- Seed the locations already used by the recovered app so the new dropdown is
-- useful immediately. Admins can update these defaults and add more locations.
insert into public.locations (name, suburb, court_1_fee, court_2_fee, ball_fee)
values
  ('Civic Park Tennis Courts', 'Pendle Hill', 54.00, 0.00, 1.00),
  ('Dirrabarri Tennis Courts', 'Greystanes', 54.00, 0.00, 1.00)
on conflict (name, suburb) do nothing;

update public.events e
set location_id = l.id
from public.locations l
where e.location_id is null
  and lower(trim(e.location)) = lower(trim(l.name))
  and lower(trim(coalesce(e.suburb, ''))) = lower(trim(coalesce(l.suburb, '')));

alter table public.locations enable row level security;
revoke all on table public.locations from anon, authenticated;

create or replace function public.set_updated_at() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists locations_updated_at on public.locations;
create trigger locations_updated_at before update on public.locations
for each row execute function public.set_updated_at();
