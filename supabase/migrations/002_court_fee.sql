-- Changes the default for future events only.
-- Existing event rows and their court_fee values are intentionally untouched.

alter table public.events
  alter column court_fee set default 54.00;
