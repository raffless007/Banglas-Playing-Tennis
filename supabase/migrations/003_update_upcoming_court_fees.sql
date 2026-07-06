-- Updates only upcoming events still using the old $52 default.
-- Other values are treated as intentional admin overrides and remain unchanged.

update public.events
set court_fee = 54.00,
    updated_at = now()
where event_date >= (now() at time zone 'Australia/Sydney')::date
  and court_fee = 52.00;
