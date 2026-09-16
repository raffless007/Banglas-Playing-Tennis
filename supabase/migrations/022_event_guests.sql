-- Event-scoped guests: guests participate in one week without entering the
-- permanent player roster or all-time player statistics.
alter table public.players
  add column if not exists is_guest boolean not null default false,
  add column if not exists guest_event_id uuid references public.events(id) on delete set null;

alter table public.events
  add column if not exists guest_invite_token text unique;

create index if not exists players_guest_event_idx
  on public.players (guest_event_id)
  where is_guest = true;
