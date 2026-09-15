alter table public.media_items add column if not exists is_favorite boolean not null default false;
