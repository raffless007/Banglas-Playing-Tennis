-- Store which permanent member invited or brought each guest.
alter table public.players
  add column if not exists guest_of_player_id uuid references public.players(id) on delete set null;

alter table public.guest_history
  add column if not exists guest_of_player_id uuid references public.players(id) on delete set null,
  add column if not exists guest_of_name text;

create index if not exists players_guest_of_idx
  on public.players (guest_of_player_id)
  where is_guest = true;

-- Preserve the current guest-of relationship for existing assignments.
update public.guest_history h
set guest_of_player_id = p.guest_of_player_id,
    guest_of_name = owner.name
from public.players p
left join public.players owner on owner.id = p.guest_of_player_id
where h.guest_player_id = p.id
  and (h.guest_of_player_id is null or h.guest_of_name is null);
