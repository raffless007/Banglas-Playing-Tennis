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
alter table public.app_settings enable row level security;
alter table public.reminder_log enable row level security;

create index if not exists match_scores_event_created_idx
  on public.match_scores (event_id, created_at);

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
