-- What step-wise indexing needs (ADR-0012, step 8).
--
-- 1. meeting_index_state is the marker a question reads instead of planning the
--    whole transcript: which transcript and model the index was finished for, how
--    many windows it holds, and whether it is complete. No row means no run has
--    finished, so a meeting indexed before this migration reads as incomplete, and
--    the next run skips what is already stored and spends nothing.
-- 2. transcript_hash fingerprints a transcript where the transcript is, so noticing
--    a replaced one costs the Worker one short string, not a read of every line.
-- 3. read_index_state answers "can this meeting be asked questions" in one call.
-- 4. upsert_windows stores a batch and the cursor after it and ends the step, under
--    the step's token in one transaction. The marker goes incomplete in the same
--    transaction, before any window of the old index is replaced.
-- 5. finish_index marks the index complete, only if the windows really add up. It is
--    also the only thing that removes windows during a run, and only those past the
--    end of this plan: another model's windows are replaced one batch at a time, so
--    no single request can empty a meeting's index.
--
-- Safe to run again: everything is conditional or replaces itself, and nothing here
-- touches a row that already exists.

create table if not exists public.meeting_index_state (
  meeting_id   uuid primary key references public.meetings (id) on delete cascade,
  -- transcript_hash() of the transcript this run indexes.
  text_hash    text not null check (text_hash ~ '^[0-9a-f]{64}$'),
  -- Vectors from different models are not comparable, so a marker holds for one.
  model        text not null check (length(model) > 0),
  -- 0 until the run finishes: only then is the plan's length known without
  -- planning the whole transcript.
  window_count integer not null default 0 check (window_count >= 0),
  complete     boolean not null default false,
  updated_at   timestamptz not null default now()
);

comment on table public.meeting_index_state is
  'Whether a meeting''s search index is complete, and for which transcript and model. A question refuses unless it is (ADR-0012).';

-- Same posture as every other table: only the service role reaches this.
alter table public.meeting_index_state enable row level security;

-- Every line's index, times and text, in order. JSON around each line, so no two
-- different transcripts can run together into the same input.
create or replace function public.transcript_hash(p_meeting uuid)
returns text
language sql
stable
set search_path = public
as $$
  select encode(sha256(convert_to(coalesce(
           string_agg(jsonb_build_array(s.idx, s.start_ms, s.end_ms, s.text)::text, E'\n' order by s.idx),
           ''), 'UTF8')), 'hex')
    from public.transcript_segments s
   where s.meeting_id = p_meeting
$$;

comment on function public.transcript_hash(uuid) is
  'SHA-256 over a meeting''s transcript, computed in the database so the Worker reads no lines to compare it (ADR-0012).';

-- Always exactly one row, marker or not. The marker's columns are null without one.
create or replace function public.read_index_state(p_meeting uuid, p_model text)
returns table (
  text_hash        text,
  model            text,
  window_count     integer,
  complete         boolean,
  current_hash     text,
  segment_count    integer,
  stored_windows   integer,
  stored_for_model integer
)
language sql
stable
set search_path = public
as $$
  select marker.text_hash, marker.model, marker.window_count, marker.complete,
         public.transcript_hash(p_meeting),
         (select count(*)::integer from public.transcript_segments s where s.meeting_id = p_meeting),
         stored.total,
         stored.for_model
    from (select count(*)::integer as total,
                 (count(*) filter (where w.model = p_model))::integer as for_model
            from public.transcript_windows w
           where w.meeting_id = p_meeting) stored
    left join public.meeting_index_state marker on marker.meeting_id = p_meeting
$$;

comment on function public.read_index_state(uuid, text) is
  'A meeting''s index marker, the hash of its transcript now, and how many windows are stored: what deciding "ready" takes, in one call (ADR-0012).';

create or replace function public.upsert_windows(
  p_meeting   uuid,
  p_token     uuid,
  p_windows   jsonb,
  p_cursor    jsonb,
  p_text_hash text,
  p_model     text
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_run public.pipeline_runs;
begin
  if jsonb_typeof(p_windows) is distinct from 'array' then
    raise exception 'upsert_windows: the windows must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_typeof(p_cursor) is distinct from 'object' then
    raise exception 'upsert_windows: the cursor must be a JSON object' using errcode = '22023';
  end if;

  v_run := public.locked_step_run(p_meeting, 'search_index', p_token);
  if v_run.meeting_id is null then
    return false;
  end if;

  -- Before any window changes: from here until finish_index, a question refuses.
  insert into public.meeting_index_state (meeting_id, text_hash, model, window_count, complete)
  values (p_meeting, p_text_hash, p_model, 0, false)
  on conflict (meeting_id) do update
     set text_hash = excluded.text_hash, model = excluded.model, window_count = 0,
         complete = false, updated_at = clock_timestamp();

  insert into public.transcript_windows
         (meeting_id, idx, first_segment_idx, last_segment_idx, start_ms, end_ms, content, content_hash, model, embedding)
  select p_meeting, x.idx, x.first_segment_idx, x.last_segment_idx, x.start_ms, x.end_ms, x.content, x.content_hash,
         p_model, x.embedding::text::extensions.vector(1024)
    from jsonb_to_recordset(p_windows) as x(
           idx integer, first_segment_idx integer, last_segment_idx integer, start_ms integer, end_ms integer,
           content text, content_hash text, embedding jsonb)
  on conflict (meeting_id, idx) do update
     set first_segment_idx = excluded.first_segment_idx,
         last_segment_idx  = excluded.last_segment_idx,
         start_ms          = excluded.start_ms,
         end_ms            = excluded.end_ms,
         content           = excluded.content,
         content_hash      = excluded.content_hash,
         model             = excluded.model,
         embedding         = excluded.embedding;

  -- A batch that finished starts the next one's count afresh.
  update public.pipeline_runs r
     set step_token = null, step_lease_until = null, step_chunk_no = null,
         attempts = 0, cursor = p_cursor, last_error = null, retry_at = null,
         updated_at = clock_timestamp()
   where r.meeting_id = p_meeting and r.stage = 'search_index';
  return true;
end
$$;

comment on function public.upsert_windows(uuid, uuid, jsonb, jsonb, text, text) is
  'Store one batch of embedded windows and the cursor after it, marking the index incomplete, and end the step; fenced on the live step token (ADR-0012).';

-- 'complete': the marker says so and the step has ended. 'lost': the token is not
-- live, and nothing was written. 'changed': what is stored is not what this run
-- planned, and nothing was written; the caller starts the plan over.
create or replace function public.finish_index(
  p_meeting      uuid,
  p_token        uuid,
  p_text_hash    text,
  p_model        text,
  p_window_count integer
)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_run public.pipeline_runs;
  v_stored integer;
  v_reaches integer;
  v_last_line integer;
begin
  if p_window_count is null or p_window_count < 0 then
    raise exception 'finish_index: the window count must not be negative, got %', p_window_count using errcode = '22023';
  end if;

  v_run := public.locked_step_run(p_meeting, 'search_index', p_token);
  if v_run.meeting_id is null then
    return 'lost';
  end if;

  if public.transcript_hash(p_meeting) is distinct from p_text_hash then
    return 'changed';
  end if;

  -- Every planned window is there under this model, and the last one reaches the
  -- transcript's last line. A plan cut short, or a hole, cannot be marked complete.
  select count(*), max(w.last_segment_idx) filter (where w.idx = p_window_count - 1)
    into v_stored, v_reaches
    from public.transcript_windows w
   where w.meeting_id = p_meeting and w.model = p_model and w.idx < p_window_count;
  select max(s.idx) into v_last_line from public.transcript_segments s where s.meeting_id = p_meeting;
  if v_stored <> p_window_count or v_reaches is distinct from v_last_line then
    return 'changed';
  end if;

  -- All that can be left is past the plan's end: a longer transcript's windows.
  delete from public.transcript_windows w where w.meeting_id = p_meeting and w.idx >= p_window_count;

  insert into public.meeting_index_state (meeting_id, text_hash, model, window_count, complete)
  values (p_meeting, p_text_hash, p_model, p_window_count, true)
  on conflict (meeting_id) do update
     set text_hash = excluded.text_hash, model = excluded.model, window_count = excluded.window_count,
         complete = true, updated_at = clock_timestamp();

  update public.pipeline_runs r
     set step_token = null, step_lease_until = null, step_chunk_no = null,
         attempts = 0, cursor = '{}'::jsonb, last_error = null, retry_at = null,
         updated_at = clock_timestamp()
   where r.meeting_id = p_meeting and r.stage = 'search_index';
  return 'complete';
end
$$;

comment on function public.finish_index(uuid, uuid, text, text, integer) is
  'Mark a meeting''s index complete and end the step, if the transcript is unchanged and every planned window is stored; fenced on the live step token (ADR-0012).';

-- A new function starts with EXECUTE for PUBLIC, and on Supabase for its API roles.
-- Only the service role reaches these. Guarded, because a plain Postgres has none of
-- these roles.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.transcript_hash(uuid)',
    'public.read_index_state(uuid, text)',
    'public.upsert_windows(uuid, uuid, jsonb, jsonb, text, text)',
    'public.finish_index(uuid, uuid, text, text, integer)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', fn);
    end if;
  end loop;
end $$;
