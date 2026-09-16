-- Move the newly added Duke Guest - Eram roster entry into the current
-- 16 September 2026 session as a one-off guest.
with target_event as (
  select id from public.events where event_date = '2026-09-16'
), moved_player as (
  update public.players
  set is_guest = true, guest_event_id = (select id from target_event)
  where name = 'Duke Guest - Eram' and exists (select 1 from target_event)
  returning id
)
insert into public.eois (event_id, player_id, status, waitlist_position, updated_at)
select (select id from target_event), id, 'yes', null, now()
from moved_player
where exists (select 1 from target_event)
on conflict (event_id, player_id) do update
set status = 'yes', waitlist_position = null, updated_at = now();
