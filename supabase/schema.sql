-- Banglas Playing Tennis — Supabase database
-- Run this entire file once in Supabase → SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  email text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  event_date date not null unique,
  start_time time not null default '19:30',
  end_time time not null default '22:00',
  timezone text not null default 'Australia/Sydney',
  location text not null default 'Civic Park Tennis Courts',
  suburb text not null default 'Pendle Hill',
  court_fee numeric(10,2) not null default 54.00,
  court_2_enabled boolean not null default false,
  court_2_name text not null default 'Court 2',
  court_2_start_time time not null default '19:30',
  court_2_end_time time not null default '22:00',
  court_2_fee numeric(10,2) not null default 0.00,
  ball_fee numeric(10,2) not null default 1.00,
  account_closed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.eois (
  event_id uuid not null references public.events(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  status text not null check (status in ('yes','no')),
  updated_at timestamptz not null default now(),
  primary key (event_id, player_id)
);

create table if not exists public.payments (
  event_id uuid not null references public.events(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  amount numeric(10,2) not null,
  paid boolean not null default false,
  paid_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (event_id, player_id)
);

create table if not exists public.match_scores (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  team_a_player_ids uuid[] not null,
  team_b_player_ids uuid[] not null,
  games_a integer not null check (games_a between 0 and 4),
  games_b integer not null check (games_b between 0 and 4),
  tiebreak_a integer,
  tiebreak_b integer,
  submitted_by uuid not null references public.players(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(team_a_player_ids) = 2),
  check (cardinality(team_b_player_ids) = 2)
);

create table if not exists public.media_items (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id),
  title text not null,
  media_type text not null check (media_type in ('image','video')),
  storage_path text not null unique,
  original_name text not null,
  mime_type text not null,
  captured_at date not null default (now() at time zone 'Australia/Sydney')::date,
  created_at timestamptz not null default now()
);

create table if not exists public.app_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

create table if not exists public.reminder_log (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  player_id uuid references public.players(id) on delete cascade,
  reminder_type text not null,
  sent_at timestamptz not null default now()
);

-- The browser never connects directly to these tables. Only Netlify Functions
-- use the server-side service-role key, so exposed-table access stays closed.
alter table public.players enable row level security;
alter table public.events enable row level security;
alter table public.eois enable row level security;
alter table public.payments enable row level security;
alter table public.match_scores enable row level security;
alter table public.media_items enable row level security;
alter table public.app_settings enable row level security;
alter table public.reminder_log enable row level security;

create index if not exists match_scores_event_created_idx
  on public.match_scores (event_id, created_at);

create index if not exists media_items_captured_created_idx
  on public.media_items (captured_at desc, created_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tennis-media', 'tennis-media', true, 209715200, array['image/*','video/*'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create unique index if not exists reminder_log_event_player_type_unique
  on public.reminder_log (event_id, player_id, reminder_type)
  where player_id is not null
    and reminder_type in ('session_end_player', '48_hour_unpaid');

create unique index if not exists reminder_log_event_type_owner_unique
  on public.reminder_log (event_id, reminder_type)
  where player_id is null
    and reminder_type = '72_hour_owner';

insert into public.players (name) values
  ('Abrar Hussain Taif'),
  ('Nabil Mohsin'),
  ('Sanjid Mahmood Hamim'),
  ('Salman Rahman Sunny'),
  ('Farhan Ahmed Chowdhury'),
  ('Farhan Ashik'),
  ('Ihsaan M. Chowdhury'),
  ('Inzamam Haque'),
  ('Mohammad Eram'),
  ('Rahat Iqbal'),
  ('Redwan Khandker'),
  ('Rizwan Chowdhury'),
  ('Sakif Hassan'),
  ('Sasmit Dewan'),
  ('Shadeed Mahmud'),
  ('Shadman Ayon'),
  ('Shadman Mahmood'),
  ('Rafeed Abrar')
on conflict (name) do nothing;

insert into public.app_settings (key, value)
values ('admin_passcode_hash', null)
on conflict (key) do nothing;
