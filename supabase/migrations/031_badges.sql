-- Editable player-badge rules. Badge criteria are evaluated by the app using
-- completed match, attendance, payment and point-differential statistics.
create table if not exists public.badges (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  min_played integer,
  min_wins integer,
  min_win_pct numeric(5,2),
  min_attendance integer,
  min_point_diff integer,
  min_paid_rate numeric(5,2),
  fallback_type text,
  enabled boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint badges_fallback_type_check check (fallback_type in ('played','no_played') or fallback_type is null),
  constraint badges_min_win_pct_check check (min_win_pct is null or (min_win_pct >= 0 and min_win_pct <= 100)),
  constraint badges_min_paid_rate_check check (min_paid_rate is null or (min_paid_rate >= 0 and min_paid_rate <= 100))
);

alter table public.badges enable row level security;
revoke all on table public.badges from anon, authenticated;

insert into public.badges
  (name, description, min_played, min_win_pct, min_attendance, min_point_diff, min_paid_rate, fallback_type, sort_order)
values
  ('Form King', 'A strong winning record after a meaningful sample of matches.', 5, 70, null, null, null, null, 10),
  ('Regular', 'A familiar face at the weekly sessions.', null, null, 8, null, null, null, 20),
  ('Point Machine', 'A standout positive point differential.', null, null, null, 20, null, null, 30),
  ('Veteran', 'A long-serving member of the match book.', 10, null, null, null, null, null, 40),
  ('Paid Up Pro', 'Consistently clears session payments.', null, null, 3, null, 100, null, 50),
  ('Building Form', 'Fallback badge for a player with matches but no earned badge yet.', null, null, null, null, null, 'played', 90),
  ('Fresh Legs', 'Fallback badge for a player waiting for a first match.', null, null, null, null, null, 'no_played', 100)
on conflict (name) do nothing;

create index if not exists badges_enabled_order_idx
  on public.badges (enabled, sort_order, name);
