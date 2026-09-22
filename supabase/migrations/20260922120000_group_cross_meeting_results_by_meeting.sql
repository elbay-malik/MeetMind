-- Fix two ordering defects in match_transcript_windows_across_meetings
-- (ADR-0008 decision 4), found by auditing the function against a real
-- pgvector instance rather than against the local driver that mirrors it.
--
-- 1. RESULTS DID NOT GROUP BY MEETING. The final `order by m.best_distance,
--    t.similarity desc, t.idx` had no meeting key, so when two meetings tied
--    on best_distance their rows interleaved — A, B, A, B, A, B — while the
--    local driver, which sorts per-meeting arrays and flattens them, always
--    returned contiguous blocks. server/utils/db/windows.ts documents the
--    contract as "grouped by meeting", so Postgres was the side breaking it.
--    Reached by nothing more exotic than uploading the same recording twice:
--    identical transcripts embed identically and tie exactly.
--
-- 2. A ZERO-NORM WINDOW SORTED FIRST INSTEAD OF LAST. `t.similarity desc`
--    ranks NaN highest, because Postgres orders NaN as greater than every
--    other float. The LATERAL's own `order by w.embedding <=> p_query` puts
--    it last, and so does the local driver's rank() helper — which exists
--    precisely because this app already fixed this class of bug once, for
--    per-meeting search. Ordering the outer query by the same distance the
--    inner one uses makes all three agree instead of two out of three.
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
           1 - (w.embedding <=> p_query) as similarity,
           -- Selected but NOT returned: the outer sort needs the same measure
           -- the inner one ranked by, and similarity cannot stand in for it
           -- (see note 2 above).
           w.embedding <=> p_query as distance
    from public.transcript_windows w
    where w.meeting_id = m.meeting_id
      and w.model = p_model
    order by w.embedding <=> p_query, w.idx
    limit least(greatest(coalesce(p_per_meeting_limit, 1), 1), 5)
  ) t
  -- meeting_id breaks a best_distance tie so a meeting's rows stay together;
  -- distance (ascending, NaN last) orders within the meeting.
  order by m.best_distance, m.meeting_id, t.distance, t.idx;
$$;

-- `create or replace function` resets privileges, so the grants have to be
-- restated here or PostgREST loses access to it.
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
