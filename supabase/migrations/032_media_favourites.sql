-- Store media favourites per player rather than globally on media_items.
-- The legacy media_items.is_favorite column is retained for compatibility but
-- is no longer used by the application.
create table if not exists public.media_favourites (
  player_id uuid not null references public.players(id) on delete cascade,
  media_id uuid not null references public.media_items(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (player_id, media_id)
);

alter table public.media_favourites enable row level security;
revoke all on table public.media_favourites from anon, authenticated;

create index if not exists media_favourites_media_idx
  on public.media_favourites (media_id);
