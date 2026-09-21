-- Search across every meeting's transcript windows at once (ADR-0008).
-- Apply with `supabase db push` or the SQL editor.

-- Still an exact scan, deliberately -- no HNSW index (ADR-0008 decision 1). An
-- unfiltered scan never hits the under-return problem HNSW's iterative-scan
-- setting exists for (that only bites a FILTERED scan), and at this app's
-- realistic scale -- dozens to low hundreds of meetings, on the order of a
-- hundred windows each -- the whole table stays orders of magnitude below
-- where sequential scan measurably slows down.
--
-- Capped per meeting via a LATERAL join, not a `ROW_NUMBER() OVER (PARTITION
-- BY meeting_id)` window function: the latter has to materialise and rank the
-- WHOLE filtered set before it can discard anything, so it cannot stop early
-- per meeting even with an index present. A LATERAL join runs the same
-- exact-scan-over-one-meeting query `match_transcript_windows` already does,
-- once per candidate meeting -- cheap for the same reason that one already is.
--
-- Two stages: first rank meetings by their own single best-matching window
-- (one pass over every current-model row), then only for the top
-- `p_meeting_limit` of those, pull each meeting's top `p_per_meeting_limit`
-- windows. This also keeps one long, repetitive meeting from crowding every
-- other meeting out of the results -- a flat top-K across all windows would
-- let it.
create or replace function public.match_transcript_windows_across_meetings(
  p_query             extensions.vector(768),
  p_model             text,
  p_meeting_limit     integer,
  p_per_meeting_limit integer
)
returns table (
  meeting_id        uuid,
  idx               integer,
  first_segment_idx integer,
  last_segment_idx  integer,
  start_ms          integer,
  end_ms            integer,
  content           text,
  content_hash      text,
  similarity        double precision
)
language sql
stable
-- Pinned, so the operator resolves to pgvector's and not to whatever an
-- earlier schema on the caller's search_path defines.
set search_path = public, extensions
as $$
  with ranked_meetings as (
    select distinct on (w.meeting_id)
           w.meeting_id, w.embedding <=> p_query as best_distance
    from public.transcript_windows w
    where w.model = p_model
    order by w.meeting_id, w.embedding <=> p_query
  ),
  top_meetings as (
    select meeting_id, best_distance from ranked_meetings
    order by best_distance
    limit least(greatest(coalesce(p_meeting_limit, 1), 1), 20)
  )
  select m.meeting_id, t.idx, t.first_segment_idx, t.last_segment_idx, t.start_ms, t.end_ms,
         t.content, t.content_hash, t.similarity
  from top_meetings m
  cross join lateral (
    select w.idx, w.first_segment_idx, w.last_segment_idx, w.start_ms, w.end_ms,
           w.content, w.content_hash,
           1 - (w.embedding <=> p_query) as similarity
    from public.transcript_windows w
    where w.meeting_id = m.meeting_id
      and w.model = p_model
    order by w.embedding <=> p_query, w.idx
    limit least(greatest(coalesce(p_per_meeting_limit, 1), 1), 5)
  ) t
  order by m.best_distance, t.similarity desc, t.idx;
$$;

-- Same posture as match_transcript_windows: only the service role reaches
-- this. Guarded, because a plain Postgres has none of these roles.
do $$
begin
  revoke all on function public.match_transcript_windows_across_meetings(extensions.vector, text, integer, integer) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.match_transcript_windows_across_meetings(extensions.vector, text, integer, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.match_transcript_windows_across_meetings(extensions.vector, text, integer, integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.match_transcript_windows_across_meetings(extensions.vector, text, integer, integer) to service_role;
  end if;
end $$;
