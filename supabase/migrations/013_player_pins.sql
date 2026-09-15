-- Per-player PINs are server-side hashes. The raw PIN is never returned to the browser.
alter table public.players
  add column if not exists pin_hash text,
  add column if not exists pin_updated_at timestamptz;

create index if not exists players_active_pin_idx
  on public.players (active)
  where active = true;
