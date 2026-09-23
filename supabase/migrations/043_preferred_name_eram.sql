-- Use Eram as the roster display name everywhere the player record is shown.
-- Existing IDs and historical audit entries remain unchanged.
update public.players as target
set name = 'Eram'
where lower(trim(target.name)) = 'mohammad eram'
  and not exists (
    select 1
    from public.players as existing
    where existing.id <> target.id
      and lower(trim(existing.name)) = 'eram'
  );

update public.guest_history
set guest_name = 'Eram'
where lower(trim(guest_name)) = 'mohammad eram';
