-- Banglas Playing Tennis — Supabase database
-- Run this entire file once in Supabase → SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  email text,
  mobile text,
  address text,
  avatar_path text,
  pin_hash text,
  pin_updated_at timestamptz,
  pin_failed_attempts integer not null default 0,
  pin_locked_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Reusable court locations. Events keep their own snapshot/override values so
-- historical weeks remain accurate when a location's defaults change.
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
insert into public.locations (name, suburb, court_1_fee, court_2_fee, ball_fee)
values
  ('Civic Park Tennis Courts', 'Pendle Hill', 54.00, 0.00, 1.00),
  ('Dirrabarri Tennis Courts', 'Greystanes', 54.00, 0.00, 1.00)
on conflict (name, suburb) do nothing;

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  event_date date not null unique,
  start_time time not null default '19:30',
  end_time time not null default '22:00',
  timezone text not null default 'Australia/Sydney',
  location_id uuid references public.locations(id) on delete set null,
  court_1_name text not null default 'Court 1',
  location text not null default 'Civic Park Tennis Courts',
  suburb text not null default 'Pendle Hill',
  entry_pin text,
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
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.players
  add column if not exists is_guest boolean not null default false,
  add column if not exists guest_event_id uuid references public.events(id) on delete set null,
  add column if not exists guest_of_player_id uuid references public.players(id) on delete set null;

alter table public.events
  add column if not exists guest_invite_token text unique;

alter table public.events add column if not exists deleted_at timestamptz;
alter table public.events
  add column if not exists location_id uuid references public.locations(id) on delete set null,
  add column if not exists entry_pin text;
update public.events e
set location_id = l.id
from public.locations l
where e.location_id is null
  and lower(trim(e.location)) = lower(trim(l.name))
  and lower(trim(coalesce(e.suburb, ''))) = lower(trim(coalesce(l.suburb, '')));

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

-- Durable guest archive. Guest participation is kept as a snapshot so a guest
-- can be reused for another week without losing their previous history.
create table if not exists public.guest_history (
  id uuid primary key default gen_random_uuid(),
  guest_player_id uuid references public.players(id) on delete set null,
  event_id uuid not null references public.events(id) on delete cascade,
  guest_name text not null,
  guest_email text,
  guest_of_player_id uuid references public.players(id) on delete set null,
  guest_of_name text,
  assigned_at timestamptz not null default now(),
  unique (event_id, guest_player_id)
);

create index if not exists guest_history_player_idx
  on public.guest_history (guest_player_id, assigned_at desc);
create index if not exists guest_history_event_idx
  on public.guest_history (event_id, assigned_at desc);

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

create table if not exists public.eoi_change_history (
  id uuid primary key default gen_random_uuid(), event_id uuid not null references public.events(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade, old_status text,
  new_status text not null check (new_status in ('yes','no')), old_waitlist_position integer,
  new_waitlist_position integer, changed_at timestamptz not null default now(), changed_by uuid references public.players(id)
);

create table if not exists public.app_sync_state (
  id text primary key, version bigint not null default 0, updated_at timestamptz not null default now()
);
insert into public.app_sync_state (id) values ('clubhouse') on conflict (id) do nothing;

create table if not exists public.player_score_drafts (
  player_id uuid not null references public.players(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  draft jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now(), primary key (player_id,event_id)
);

create table if not exists public.admin_backup_runs (
  id uuid primary key default gen_random_uuid(), requested_by text not null,
  table_counts jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
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
    foreign key (live_match_id) references public.live_matches(id) on delete set null;

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

create table if not exists public.media_favourites (
  player_id uuid not null references public.players(id) on delete cascade,
  media_id uuid not null references public.media_items(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (player_id, media_id)
);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
  actor_player_id uuid references public.players(id), actor_type text not null default 'system', actor_name text,
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
  player_id uuid references public.players(id) on delete set null,
  title text,
  body text,
  url text,
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  error_message text,
  delivered_at timestamptz,
  unique (subscription_id, notification_key)
);

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
  recipient_ids jsonb not null default '[]'::jsonb,
  device_count integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  status text not null default 'pending' check (status in ('pending','sent','partial','failed','no_recipients','skipped')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.push_alert_schedules (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  notification_type text not null default 'payments',
  delay_minutes integer not null default 0 check (delay_minutes >= 0),
  repeat_interval_minutes integer check (repeat_interval_minutes is null or repeat_interval_minutes > 0),
  title_template text not null default 'Tennis payment reminder',
  body_template text not null default '{date}: ${amount} is still outstanding at {location}. PayID {payid}.',
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_alert_schedules_type_check check (notification_type in ('payments','eoi','session','matches'))
);

insert into public.push_alert_schedules
  (code, name, notification_type, delay_minutes, repeat_interval_minutes, title_template, body_template, sort_order)
values
  ('payment-30m', '30 minutes after session completion', 'payments', 30, null,
   'Payment due · {date}', '{date}: ${amount} is due at {location}. PayID {payid}.', 10),
  ('payment-12h', '12 hours after session completion', 'payments', 720, null,
   'Payment overdue · {date}', '{date}: ${amount} is still outstanding at {location}. PayID {payid}.', 20),
  ('payment-36h', '36 hours after session completion', 'payments', 2160, null,
   'Payment overdue · {date}', '{date}: ${amount} is still outstanding at {location}. PayID {payid}.', 30),
  ('payment-daily', 'Every 24 hours until paid', 'payments', 3600, 1440,
   'Payment overdue · {date}', '{date}: ${amount} is still outstanding at {location}. PayID {payid}.', 40)
on conflict (code) do nothing;

create table if not exists public.badges (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  min_played integer,
  min_wins integer,
  min_win_pct numeric(5,2),
  min_attendance integer,
  min_point_diff integer,
  min_paid_rate numeric(5,2),
  fallback_type text,
  enabled boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint badges_fallback_type_check check (fallback_type in ('played','no_played') or fallback_type is null),
  constraint badges_min_win_pct_check check (min_win_pct is null or (min_win_pct >= 0 and min_win_pct <= 100)),
  constraint badges_min_paid_rate_check check (min_paid_rate is null or (min_paid_rate >= 0 and min_paid_rate <= 100))
);

insert into public.badges
  (name, description, min_played, min_win_pct, min_attendance, min_point_diff, min_paid_rate, fallback_type, sort_order)
values
  ('Form King', 'A strong winning record after a meaningful sample of matches.', 5, 70, null, null, null, null, 10),
  ('Regular', 'A familiar face at the weekly sessions.', null, null, 8, null, null, null, 20),
  ('Point Machine', 'A standout positive point differential.', null, null, null, 20, null, null, 30),
  ('Veteran', 'A long-serving member of the match book.', 10, null, null, null, null, null, 40),
  ('Paid Up Pro', 'Consistently clears session payments.', null, null, 3, null, 100, null, 50),
  ('Building Form', 'Fallback badge for a player with matches but no earned badge yet.', null, null, null, null, null, 'played', 90),
  ('Fresh Legs', 'Fallback badge for a player waiting for a first match.', null, null, null, null, null, 'no_played', 100)
on conflict (name) do nothing;

-- The browser never connects directly to these tables. Only Netlify Functions
-- use the server-side service-role key, so exposed-table access stays closed.
alter table public.players enable row level security;
alter table public.locations enable row level security;
alter table public.events enable row level security;
alter table public.deleted_event_dates enable row level security;
alter table public.eois enable row level security;
alter table public.payments enable row level security;
alter table public.match_scores enable row level security;
alter table public.live_matches enable row level security;
alter table public.event_notes enable row level security;
alter table public.media_items enable row level security;
alter table public.media_favourites enable row level security;
alter table public.audit_log enable row level security;
alter table public.event_templates enable row level security;
revoke all on table public.audit_log, public.event_templates from anon, authenticated;
revoke all on table public.locations from anon, authenticated;
revoke all on table public.media_favourites from anon, authenticated;
alter table public.app_settings enable row level security;
alter table public.reminder_log enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_notification_log enable row level security;
alter table public.push_alerts enable row level security;
alter table public.push_alert_schedules enable row level security;
alter table public.badges enable row level security;
revoke all on table public.push_alerts from anon, authenticated;
revoke all on table public.push_alert_schedules from anon, authenticated;
revoke all on table public.badges from anon, authenticated;
create index if not exists push_alert_schedules_enabled_idx
  on public.push_alert_schedules (enabled, sort_order);
create index if not exists badges_enabled_order_idx
  on public.badges (enabled, sort_order, name);
alter table public.guest_history enable row level security;

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

create index if not exists media_favourites_media_idx
  on public.media_favourites (media_id);

create index if not exists players_active_pin_idx
  on public.players (active)
  where active = true;

create index if not exists push_subscriptions_player_active_idx
  on public.push_subscriptions (player_id, active);

create index if not exists push_notification_log_key_idx
  on public.push_notification_log (notification_key);
create index if not exists push_alerts_created_idx
  on public.push_alerts (created_at desc);
create index if not exists push_notification_log_status_idx
  on public.push_notification_log (status, sent_at desc);

create table if not exists public.player_notifications (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  event_id uuid references public.events(id) on delete set null,
  notification_type text not null default 'session',
  title text not null,
  body text not null,
  url text not null default '/?page=play',
  dedupe_key text not null,
  group_key text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (player_id, dedupe_key)
);
alter table public.player_notifications enable row level security;
revoke all on public.player_notifications from anon, authenticated;
create index if not exists player_notifications_player_read_created_idx
  on public.player_notifications (player_id, read_at, created_at desc);
create index if not exists player_notifications_group_idx
  on public.player_notifications (player_id, group_key, created_at desc);

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

-- WebAuthn/passkeys (Face ID, Touch ID, Android biometrics and security keys).
create table if not exists public.passkeys (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  credential_id text not null unique,
  public_key text not null,
  counter bigint not null default 0,
  transports jsonb not null default '[]'::jsonb,
  friendly_name text not null default 'This device',
  device_type text,
  backed_up boolean not null default false,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.passkeys enable row level security;
revoke all on public.passkeys from anon, authenticated;
create index if not exists passkeys_player_idx on public.passkeys(player_id);

create table if not exists public.webauthn_challenges (
  id uuid primary key default gen_random_uuid(),
  player_id uuid references public.players(id) on delete cascade,
  challenge_type text not null check (challenge_type in ('registration', 'authentication')),
  challenge text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.webauthn_challenges enable row level security;
revoke all on public.webauthn_challenges from anon, authenticated;
create index if not exists webauthn_challenges_expiry_idx
  on public.webauthn_challenges(expires_at, consumed_at);

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

-- Reliability helpers (also delivered as migration 034 for existing projects).
create index if not exists events_visible_date_idx on public.events(event_date) where deleted_at is null;
create index if not exists eoi_change_history_lookup_idx on public.eoi_change_history(event_id, player_id, changed_at desc);
create index if not exists live_matches_event_updated_idx on public.live_matches(event_id, updated_at desc);
create index if not exists player_notifications_player_read_idx on public.player_notifications(player_id, read_at, created_at desc);
alter table public.eoi_change_history enable row level security;
alter table public.app_sync_state enable row level security;
alter table public.player_score_drafts enable row level security;
alter table public.admin_backup_runs enable row level security;
revoke all on public.eoi_change_history, public.app_sync_state, public.player_score_drafts, public.admin_backup_runs from anon, authenticated;

create or replace function public.record_eoi_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or old.status is distinct from new.status or old.waitlist_position is distinct from new.waitlist_position then
    insert into public.eoi_change_history (event_id, player_id, old_status, new_status, old_waitlist_position, new_waitlist_position)
    values (new.event_id, new.player_id, case when tg_op = 'INSERT' then null else old.status end, new.status,
            case when tg_op = 'INSERT' then null else old.waitlist_position end, new.waitlist_position);
  end if;
  return new;
end;
$$;
drop trigger if exists eoi_change_history_trigger on public.eois;
create trigger eoi_change_history_trigger after insert or update of status, waitlist_position on public.eois
for each row execute function public.record_eoi_change();

create or replace function public.bump_app_sync_state() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.app_sync_state set version = version + 1, updated_at = now() where id = 'clubhouse';
  return coalesce(new, old);
end;
$$;
do $$
declare table_name text;
begin
  foreach table_name in array array['events','eois','payments','match_scores','live_matches','media_items','player_notifications'] loop
    execute format('drop trigger if exists %I on public.%I', 'app_sync_' || table_name, table_name);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.bump_app_sync_state()', 'app_sync_' || table_name, table_name);
  end loop;
end $$;

-- Per-device player sessions. Each login has an isolated server-tracked token.
create table if not exists public.player_sessions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  session_id uuid not null unique,
  device_label text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists player_sessions_player_idx on public.player_sessions(player_id, last_seen_at desc);
create index if not exists player_sessions_active_idx on public.player_sessions(session_id) where revoked_at is null;
alter table public.player_sessions enable row level security;
revoke all on public.player_sessions from anon, authenticated;

-- Admin session tracking and live-point idempotency. These objects are
-- intentionally service-role only; the Netlify API is the authorization layer.
create table if not exists public.admin_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique,
  label text not null default 'Admin browser',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists admin_sessions_active_idx on public.admin_sessions(session_id) where revoked_at is null;
alter table public.admin_sessions enable row level security;
revoke all on public.admin_sessions from anon, authenticated;

create table if not exists public.live_point_actions (
  action_id uuid primary key,
  live_match_id uuid not null references public.live_matches(id) on delete cascade,
  winner text not null check (winner in ('a','b')),
  status text not null default 'applied' check (status in ('pending','applied')),
  result jsonb,
  created_at timestamptz not null default now()
);
create index if not exists live_point_actions_match_idx on public.live_point_actions(live_match_id, created_at);
alter table public.live_point_actions enable row level security;
revoke all on public.live_point_actions from anon, authenticated;

alter table public.live_matches
  add column if not exists active_scorer_id uuid references public.players(id) on delete set null,
  add column if not exists scorer_lease_until timestamptz;
create index if not exists live_matches_scorer_idx on public.live_matches(active_scorer_id, scorer_lease_until);
