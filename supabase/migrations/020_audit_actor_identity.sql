-- Preserve the display name of the person who performed an activity.
-- This keeps historical audit entries readable even if a player is renamed
-- or removed from the active roster later.
alter table public.audit_log
  add column if not exists actor_name text;

