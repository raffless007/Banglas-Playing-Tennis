-- Keep saved scores when their temporary live-match row is cleaned up.
alter table public.match_scores
  drop constraint if exists match_scores_live_match_id_fkey;

alter table public.match_scores
  add constraint match_scores_live_match_id_fkey
  foreign key (live_match_id)
  references public.live_matches(id)
  on delete set null;
