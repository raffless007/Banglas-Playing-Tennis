-- Rename in place: retain the existing badge ID, eligibility and assignment
-- keys so this cosmetic change does not create earned/removed notifications.
begin;

update public.badges
set name = 'Tough Stretch', updated_at = now()
where name = 'Disgrace';

update public.player_badge_states as state
set badge_name = 'Tough Stretch'
where state.badge_name = 'Disgrace'
  and exists (
    select 1 from public.badges as badge
    where badge.id::text = state.badge_key and badge.name = 'Tough Stretch'
  );

commit;
