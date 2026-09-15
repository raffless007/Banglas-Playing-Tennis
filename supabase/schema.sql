-- Banglas Playing Tennis — Supabase database
-- Run this entire file once in Supabase → SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  email text,
  pin_hash text,
  pin_updated_at timestamptz,
  pin_failed_attempts integer not null default 0,
  pin_locked_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  event_date date not null unique,
  start_time time not null default '19:30',
  end_time time not null default '22:00',
  timezone text not null default 'Australia/Sydney',
  court_1_name text not null default 'Court 1',
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
  max_players integer not null default 0,
  cancellation_status text not null default 'scheduled',
  cancellation_reason text,
  recap_notes text,
  award_player_id uuid references public.players(id),
  template_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.deleted_event_dates (
  event_date date primary key,
  deleted_at timestamptz not null default now()
);

create table if not exists public.eois (
  event_id uuid not null references public.events(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  status text not null check (status in ('yes','no')),
  waitlist_position integer,
  attendance_status text not null default 'pending' check (attendance_status in ('pending','attended','late','no_show','substitute')),
  checked_in_at timestamptz,
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
  points_a integer not null default 0,
  points_b integer not null default 0,
  submitted_by uuid not null references public.players(id),
  live_match_id uuid,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(team_a_player_ids) = 2),
  check (cardinality(team_b_player_ids) = 2)
);

create table if not exists public.live_matches (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  team_a_player_ids uuid[] not null,
  team_b_player_ids uuid[] not null,
  server_player_id uuid references public.players(id),
  server_order uuid[] not null default '{}',
  server_index integer not null default 0,
  games_a integer not null default 0,
  games_b integer not null default 0,
  point_a integer not null default 0,
  point_b integer not null default 0,
  tiebreak_a integer not null default 0,
  tiebreak_b integer not null default 0,
  points_a integer not null default 0,
  points_b integer not null default 0,
  is_tiebreak boolean not null default false,
  completed boolean not null default false,
  needs_server_choice boolean not null default false,
  point_history jsonb not null default '[]'::jsonb,
  version integer not null default 0,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  created_by uuid not null references public.players(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(team_a_player_ids) = 2),
  check (cardinality(team_b_player_ids) = 2)
);

alter table public.match_scores
  drop constraint if exists match_scores_live_match_id_fkey,
  add constraint match_scores_live_match_id_fkey
    foreign key (live_match_id) references public.live_matches(id);

create table if not exists public.event_notes (
  event_id uuid primary key references public.events(id) on delete cascade,
  note text not null default '',
  updated_by uuid references public.players(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.media_items (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id),
  title text not null,
  media_type text not null check (media_type in ('image','video')),
  storage_path text not null unique,
  original_name text not null,
  mime_type text not null,
  file_size bigint not null default 0,
  captured_at date not null default (now() at time zone 'Australia/Sydney')::date,
  album text not null default 'General',
  tags text[] not null default '{}',
  is_favorite boolean not null default false,
  consent_confirmed boolean not null default false,
  reported_at timestamptz,
  report_reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
  actor_player_id uuid references public.players(id), actor_type text not null default 'system',
  action text not null, target_type text, target_id uuid, outcome text not null default 'success',
  details jsonb not null default '{}'::jsonb, before_state jsonb, after_state jsonb
);

create table if not exists public.event_templates (
  id uuid primary key default gen_random_uuid(), name text not null unique,
  created_by uuid references public.players(id), config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
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

-- The browser never connects directly to these tables. Only Netlify Functions
-- use the server-side service-role key, so exposed-table access stays closed.
alter table public.players enable row level security;
alter table public.events enable row level security;
alter table public.deleted_event_dates enable row level security;
alter table public.eois enable row level security;
alter table public.payments enable row level security;
alter table public.match_scores enable row level security;
alter table public.live_matches enable row level security;
alter table public.event_notes enable row level security;
alter table public.media_items enable row level security;
alter table public.audit_log enable row level security;
alter table public.event_templates enable row level security;
revoke all on table public.audit_log, public.event_templates from anon, authenticated;
alter table public.app_settings enable row level security;
alter table public.reminder_log enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_notification_log enable row level security;

create or replace function public.record_player_pin_failure(target_player_id uuid)
returns table(failed_attempts integer, pin_locked_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.players
  set pin_failed_attempts = least(coalesce(pin_failed_attempts, 0) + 1, 5),
      pin_locked_at = case
        when coalesce(pin_failed_attempts, 0) + 1 >= 5 then coalesce(pin_locked_at, now())
        else pin_locked_at
      end
  where id = target_player_id
    and active = true
  returning public.players.pin_failed_attempts, public.players.pin_locked_at;
end;
$$;

revoke all on function public.record_player_pin_failure(uuid) from public, anon, authenticated;
grant execute on function public.record_player_pin_failure(uuid) to service_role;

create index if not exists match_scores_event_created_idx
  on public.match_scores (event_id, created_at);

create index if not exists live_matches_event_updated_idx
  on public.live_matches (event_id, completed, updated_at desc);

create unique index if not exists live_matches_one_active_per_event_idx
  on public.live_matches (event_id)
  where completed = false;

create unique index if not exists match_scores_live_match_id_unique
  on public.match_scores (live_match_id)
  where live_match_id is not null;

create index if not exists event_notes_updated_idx
  on public.event_notes (updated_at desc);

create index if not exists media_items_captured_created_idx
  on public.media_items (captured_at desc, created_at desc);

create index if not exists players_active_pin_idx
  on public.players (active)
  where active = true;

create index if not exists push_subscriptions_player_active_idx
  on public.push_subscriptions (player_id, active);

create index if not exists push_notification_log_key_idx
  on public.push_notification_log (notification_key);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tennis-media', 'tennis-media', false, 52428800, array['image/*','video/*'])
on conflict (id) do update set
  public = false,
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
