-- Optional second court and public session-media archive.

alter table public.events
  add column if not exists court_2_enabled boolean not null default false,
  add column if not exists court_2_name text not null default 'Court 2',
  add column if not exists court_2_start_time time not null default '19:30',
  add column if not exists court_2_end_time time not null default '22:00',
  add column if not exists court_2_fee numeric(10,2) not null default 0.00;

create table if not exists public.media_items (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id),
  title text not null,
  media_type text not null check (media_type in ('image','video')),
  storage_path text not null unique,
  original_name text not null,
  mime_type text not null,
  captured_at date not null default (now() at time zone 'Australia/Sydney')::date,
  created_at timestamptz not null default now()
);

alter table public.media_items enable row level security;

create index if not exists media_items_captured_created_idx
  on public.media_items (captured_at desc, created_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tennis-media', 'tennis-media', true, 209715200, array['image/*','video/*'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
