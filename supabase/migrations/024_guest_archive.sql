-- Keep a permanent, reusable archive of every guest appearance.
create table if not exists public.guest_history (
  id uuid primary key default gen_random_uuid(),
  guest_player_id uuid references public.players(id) on delete set null,
  event_id uuid not null references public.events(id) on delete cascade,
  guest_name text not null,
  guest_email text,
  assigned_at timestamptz not null default now(),
  unique (event_id, guest_player_id)
);

create index if not exists guest_history_player_idx
  on public.guest_history (guest_player_id, assigned_at desc);
create index if not exists guest_history_event_idx
  on public.guest_history (event_id, assigned_at desc);

alter table public.guest_history enable row level security;

-- Backfill guests already attached to a week before the archive existed.
insert into public.guest_history (guest_player_id, event_id, guest_name, guest_email, assigned_at)
select p.id, p.guest_event_id, p.name, p.email, coalesce(e.updated_at, now())
from public.players p
join public.events e on e.id = p.guest_event_id
where p.is_guest = true and p.guest_event_id is not null
on conflict (event_id, guest_player_id) do nothing;
