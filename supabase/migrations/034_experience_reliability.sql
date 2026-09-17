-- Experience reliability and safety upgrades.
-- Apply once in Supabase SQL Editor (or with supabase db push).

alter table public.events add column if not exists deleted_at timestamptz;
create index if not exists events_visible_date_idx on public.events (event_date) where deleted_at is null;

create table if not exists public.eoi_change_history (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  old_status text,
  new_status text not null check (new_status in ('yes','no')),
  old_waitlist_position integer,
  new_waitlist_position integer,
  changed_at timestamptz not null default now(),
  changed_by uuid references public.players(id) on delete set null
);
create index if not exists eoi_change_history_lookup_idx on public.eoi_change_history (event_id, player_id, changed_at desc);

create or replace function public.record_eoi_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or old.status is distinct from new.status or old.waitlist_position is distinct from new.waitlist_position then
    insert into public.eoi_change_history (event_id, player_id, old_status, new_status, old_waitlist_position, new_waitlist_position, changed_by)
    values (new.event_id, new.player_id, case when tg_op = 'INSERT' then null else old.status end, new.status,
            case when tg_op = 'INSERT' then null else old.waitlist_position end, new.waitlist_position, null);
  end if;
  return new;
end;
$$;
drop trigger if exists eoi_change_history_trigger on public.eois;
create trigger eoi_change_history_trigger
after insert or update of status, waitlist_position on public.eois
for each row execute function public.record_eoi_change();

create table if not exists public.app_sync_state (
  id text primary key,
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.app_sync_state (id) values ('clubhouse') on conflict (id) do nothing;

create or replace function public.bump_app_sync_state() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.app_sync_state set version = version + 1, updated_at = now() where id = 'clubhouse';
  return coalesce(new, old);
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['events','eois','payments','match_scores','live_matches','media_items','player_notifications'] loop
    execute format('drop trigger if exists %I on public.%I', 'app_sync_' || table_name, table_name);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.bump_app_sync_state()', 'app_sync_' || table_name, table_name);
  end loop;
end $$;

create table if not exists public.player_score_drafts (
  player_id uuid not null references public.players(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  draft jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (player_id, event_id)
);

create table if not exists public.admin_backup_runs (
  id uuid primary key default gen_random_uuid(),
  requested_by text not null,
  table_counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists live_matches_event_updated_idx on public.live_matches (event_id, updated_at desc);
create index if not exists player_notifications_player_read_idx on public.player_notifications (player_id, read_at, created_at desc);
create index if not exists push_notification_log_player_sent_idx on public.push_notification_log (player_id, sent_at desc);

alter table public.eois drop constraint if exists eois_waitlist_position_positive;
alter table public.eois add constraint eois_waitlist_position_positive check (waitlist_position is null or waitlist_position > 0) not valid;
alter table public.payments drop constraint if exists payments_paid_at_consistent;
alter table public.payments add constraint payments_paid_at_consistent check (not paid or paid_at is not null) not valid;

alter table public.eoi_change_history enable row level security;
alter table public.app_sync_state enable row level security;
alter table public.player_score_drafts enable row level security;
alter table public.admin_backup_runs enable row level security;
revoke all on public.eoi_change_history, public.app_sync_state, public.player_score_drafts, public.admin_backup_runs from anon, authenticated;

do $$
begin
  begin alter publication supabase_realtime add table public.events; exception when duplicate_object then null; when undefined_object then null; end;
  begin alter publication supabase_realtime add table public.eois; exception when duplicate_object then null; when undefined_object then null; end;
  begin alter publication supabase_realtime add table public.payments; exception when duplicate_object then null; when undefined_object then null; end;
  begin alter publication supabase_realtime add table public.match_scores; exception when duplicate_object then null; when undefined_object then null; end;
  begin alter publication supabase_realtime add table public.live_matches; exception when duplicate_object then null; when undefined_object then null; end;
end $$;
