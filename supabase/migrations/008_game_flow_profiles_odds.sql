alter table public.live_matches
  add column if not exists server_order uuid[] not null default '{}',
  add column if not exists server_index integer not null default 0,
  add column if not exists needs_server_choice boolean not null default false,
  add column if not exists point_history jsonb not null default '[]'::jsonb;

create table if not exists public.event_notes (
  event_id uuid primary key references public.events(id) on delete cascade,
  note text not null default '',
  updated_by uuid references public.players(id),
  updated_at timestamptz not null default now()
);

alter table public.event_notes enable row level security;

create index if not exists event_notes_updated_idx
  on public.event_notes (updated_at desc);
