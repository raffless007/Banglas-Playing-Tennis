alter table public.players
  add column if not exists mobile text,
  add column if not exists address text,
  add column if not exists avatar_path text;
