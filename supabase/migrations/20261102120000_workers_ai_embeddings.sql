-- Embeddings move to Cloudflare Workers AI's bge-m3, at 1024 dimensions (ADR-0014).
--
-- Windows are derived from transcripts and can be embedded again, so they are
-- deleted rather than converted: a 768-dimension value cannot be cast to 1024. The
-- real project holds none yet. Afterwards every meeting reads as not indexed, and
-- the progress page offers indexing as usual.
--
-- Also drops match_transcript_windows_across_meetings, which nothing has called
-- since ADR-0013 (its decision 7 left this for a cleanup migration).
--
-- Safe to run again: everything is conditional, and the delete runs only while the
-- column is not yet 1024, so a second run cannot lose windows the first let in.

drop function if exists public.match_transcript_windows_across_meetings(extensions.vector, text, integer, integer);
drop function if exists public.match_transcript_windows(uuid, extensions.vector, text, integer);

do $$
declare
  v_index regclass;
begin
  -- No migration here creates an index on this column, on purpose (ADR-0007
  -- decision 4), but one built by hand would hold the old size. Through pg_depend,
  -- so an index over an expression of the column is found too.
  for v_index in
    select distinct d.objid::regclass
    from pg_depend d
    join pg_class c on c.oid = d.objid and c.relkind = 'i'
    join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
    where d.classid = 'pg_class'::regclass
      and d.refclassid = 'pg_class'::regclass
      and d.refobjid = 'public.transcript_windows'::regclass
      and a.attname = 'embedding'
  loop
    execute format('drop index %s', v_index);
  end loop;

  if (select a.atttypmod from pg_attribute a
      where a.attrelid = 'public.transcript_windows'::regclass and a.attname = 'embedding') <> 1024 then
    delete from public.transcript_windows;
    alter table public.transcript_windows alter column embedding type extensions.vector(1024);
  end if;
end $$;

-- As before but for the size: nearest windows to a question within ONE meeting, by
-- cosine similarity, by exact scan, with the limit clamped (ADR-0007 decision 4).
create function public.match_transcript_windows(
  p_meeting_id  uuid,
  p_query       extensions.vector(1024),
  p_model       text,
  p_match_count integer
)
returns table (
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
-- Pinned, so the operator resolves to pgvector's and not to whatever an earlier
-- schema on the caller's search_path defines.
set search_path = public, extensions
as $$
  select w.idx, w.first_segment_idx, w.last_segment_idx, w.start_ms, w.end_ms,
         w.content, w.content_hash,
         1 - (w.embedding <=> p_query) as similarity
  from public.transcript_windows w
  where w.meeting_id = p_meeting_id
    and w.model = p_model
  order by w.embedding <=> p_query, w.idx
  limit least(greatest(coalesce(p_match_count, 1), 1), 20);
$$;

-- A new function starts with EXECUTE for PUBLIC, and on Supabase for its API roles.
-- Only the service role reaches this. Guarded, because a plain Postgres has none of
-- these roles.
do $$
begin
  revoke all on function public.match_transcript_windows(uuid, extensions.vector, text, integer) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.match_transcript_windows(uuid, extensions.vector, text, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.match_transcript_windows(uuid, extensions.vector, text, integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.match_transcript_windows(uuid, extensions.vector, text, integer) to service_role;
  end if;
end $$;
