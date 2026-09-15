-- Clubhouse experience upgrades: auditability, capacity, cancellation, recap,
-- attendance, private media metadata, and reusable event templates.

alter table public.events
  add column if not exists max_players integer not null default 0,
  add column if not exists cancellation_status text not null default 'scheduled',
  add column if not exists cancellation_reason text,
  add column if not exists recap_notes text,
  add column if not exists award_player_id uuid references public.players(id),
  add column if not exists template_name text;

alter table public.events
  drop constraint if exists events_cancellation_status_check;
alter table public.events
  add constraint events_cancellation_status_check
  check (cancellation_status in ('scheduled', 'cancelled', 'rain_delay', 'rescheduled'));

alter table public.eois
  add column if not exists waitlist_position integer,
  add column if not exists attendance_status text not null default 'pending',
  add column if not exists checked_in_at timestamptz;

alter table public.eois
  drop constraint if exists eois_attendance_status_check;
alter table public.eois
  add constraint eois_attendance_status_check
  check (attendance_status in ('pending', 'attended', 'late', 'no_show', 'substitute'));

alter table public.media_items
  add column if not exists album text not null default 'General',
  add column if not exists tags text[] not null default '{}',
  add column if not exists is_favorite boolean not null default false,
  add column if not exists consent_confirmed boolean not null default false,
  add column if not exists reported_at timestamptz,
  add column if not exists report_reason text;

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_player_id uuid references public.players(id),
  actor_type text not null default 'system' check (actor_type in ('admin', 'player', 'system', 'anonymous')),
  action text not null,
  target_type text,
  target_id uuid,
  outcome text not null default 'success' check (outcome in ('success', 'failed')),
  details jsonb not null default '{}'::jsonb,
  before_state jsonb,
  after_state jsonb
);

create index if not exists audit_log_created_at_idx on public.audit_log(created_at desc);
create index if not exists audit_log_target_idx on public.audit_log(target_type, target_id);
create index if not exists eois_waitlist_idx on public.eois(event_id, waitlist_position);

create table if not exists public.event_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_by uuid references public.players(id),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.audit_log enable row level security;
alter table public.event_templates enable row level security;
revoke all on table public.audit_log from anon, authenticated;
revoke all on table public.event_templates from anon, authenticated;

create or replace function public.prevent_audit_log_mutation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  raise exception 'audit_log is append-only';
end;
$$;

drop trigger if exists audit_log_append_only on public.audit_log;
create trigger audit_log_append_only
before update or delete on public.audit_log
for each row execute function public.prevent_audit_log_mutation();

-- Media is served with signed URLs by the API, never as a public bucket.
update storage.buckets set public = false where id = 'tennis-media';
