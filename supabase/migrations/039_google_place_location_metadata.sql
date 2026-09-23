-- Optional Google Places metadata for reusable court locations.
-- Fees, entry PINs and event-level overrides remain application-owned fields.
alter table public.locations
  add column if not exists google_place_id text,
  add column if not exists address text,
  add column if not exists latitude double precision,
  add column if not exists longitude double precision,
  add column if not exists google_maps_url text;

create unique index if not exists locations_google_place_id_idx
  on public.locations (google_place_id)
  where google_place_id is not null;
