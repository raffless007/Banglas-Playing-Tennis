alter table public.events
  add column if not exists court_1_name text not null default 'Court 1';

update public.events
set court_1_name = 'Court 1'
where nullif(trim(court_1_name), '') is null;

alter table public.events
  alter column court_1_name set default 'Court 1',
  alter column court_1_name set not null;
