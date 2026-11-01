-- What step-wise transcription needs from the run ledger (ADR-0012, step 7).
--
-- 1. append_segments stores one page of transcript and the cursor after it, and
--    ends the step, under the step's token in one transaction. Everything from
--    the page's first index on is replaced: a retried page replaces itself, and
--    rows of an abandoned attempt past the new end go too.
-- 2. finish_transcription starts the summarization run with its plan already
--    written and moves transcribing -> summarizing, in one transaction, so a
--    crash cannot leave the meeting moved with no plan or planned with no move.
--    With p_refusal, the transcript is too long to extract: no plan is written,
--    and the meeting moves to failed/summarization instead.
--
-- Both refuse unless the meeting is `transcribing`, read under the meeting's own
-- row lock: past transcription, a transcript is never replaced (ADR-0012 §3).
-- A token alone could not promise that, since it says who holds the stage and
-- not what the meeting has become.

create function public.append_segments(
  p_meeting  uuid,
  p_token    uuid,
  p_from_idx integer,
  p_segments jsonb,
  p_cursor   jsonb
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_run public.pipeline_runs;
begin
  if p_from_idx is null or p_from_idx < 0 then
    raise exception 'append_segments: a page must start at a segment index, got %', p_from_idx using errcode = '22023';
  end if;
  if jsonb_typeof(p_segments) is distinct from 'array' then
    raise exception 'append_segments: the segments must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_typeof(p_cursor) is distinct from 'object' then
    raise exception 'append_segments: the cursor must be a JSON object' using errcode = '22023';
  end if;
  -- The page's numbering is what keeps the transcript gapless across pages.
  if exists (
    select 1 from jsonb_array_elements(p_segments) with ordinality as e(value, position)
     where (e.value ->> 'idx')::integer is distinct from p_from_idx + e.position::integer - 1
  ) then
    raise exception 'append_segments: a page must be numbered consecutively from %', p_from_idx using errcode = '22023';
  end if;

  v_run := public.locked_step_run(p_meeting, 'transcription', p_token);
  if v_run.meeting_id is null then
    return false;
  end if;
  perform 1 from public.meetings m where m.id = p_meeting and m.status = 'transcribing';
  if not found then
    return false;
  end if;

  delete from public.transcript_segments s where s.meeting_id = p_meeting and s.idx >= p_from_idx;
  insert into public.transcript_segments (meeting_id, idx, start_ms, end_ms, text)
  select p_meeting, x.idx, x.start_ms, x.end_ms, x.text
    from jsonb_to_recordset(p_segments) as x(idx integer, start_ms integer, end_ms integer, text text);

  -- A page that finished starts the next one's count afresh.
  update public.pipeline_runs r
     set step_token = null, step_lease_until = null, step_chunk_no = null,
         attempts = 0, cursor = p_cursor, last_error = null, retry_at = null,
         updated_at = clock_timestamp()
   where r.meeting_id = p_meeting and r.stage = 'transcription';
  return true;
end
$$;

comment on function public.append_segments(uuid, uuid, integer, jsonb, jsonb) is
  'Store one page of transcript and the cursor after it, replacing everything from p_from_idx on, and end the step; fenced on the live step token and on the meeting being transcribing (ADR-0012).';

create function public.finish_transcription(
  p_meeting uuid,
  p_token   uuid,
  p_chunks  jsonb,
  p_refusal text default null
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_run public.pipeline_runs;
  v_extraction_run uuid;
begin
  if jsonb_typeof(p_chunks) is distinct from 'array' then
    raise exception 'finish_transcription: the plan must be a JSON array' using errcode = '22023';
  end if;

  v_run := public.locked_step_run(p_meeting, 'transcription', p_token);
  if v_run.meeting_id is null then
    return false;
  end if;
  perform 1 from public.meetings m where m.id = p_meeting and m.status = 'transcribing';
  if not found then
    return false;
  end if;

  -- A new run: the transcript is new, so nothing an older run planned or
  -- extracted applies to it.
  insert into public.pipeline_runs (meeting_id, stage) values (p_meeting, 'summarization')
  on conflict (meeting_id, stage) do nothing;
  update public.pipeline_runs r
     set run_id = gen_random_uuid(), cursor = '{}'::jsonb,
         step_token = null, step_lease_until = null, step_chunk_no = null,
         attempts = 0, last_error = null, retry_at = null, updated_at = clock_timestamp()
   where r.meeting_id = p_meeting and r.stage = 'summarization'
  returning r.run_id into v_extraction_run;

  delete from public.summary_chunks c where c.meeting_id = p_meeting;
  if p_refusal is null then
    insert into public.summary_chunks (meeting_id, chunk_no, run_id, seg_from, seg_to, est_tokens)
    select p_meeting, x.chunk_no, v_extraction_run, x.seg_from, x.seg_to, x.est_tokens
      from jsonb_to_recordset(p_chunks) as x(chunk_no integer, seg_from integer, seg_to integer, est_tokens integer);
  end if;

  update public.pipeline_runs r
     set step_token = null, step_lease_until = null, step_chunk_no = null,
         attempts = 0, cursor = '{}'::jsonb, last_error = null, retry_at = null,
         updated_at = clock_timestamp()
   where r.meeting_id = p_meeting and r.stage = 'transcription';

  update public.meetings m
     set status        = case when p_refusal is null then 'summarizing' else 'failed' end,
         failed_stage  = case when p_refusal is null then null else 'summarization' end,
         error_message = p_refusal
   where m.id = p_meeting;
  return true;
end
$$;

comment on function public.finish_transcription(uuid, uuid, jsonb, text) is
  'End transcription: a new summarization run with this plan and transcribing -> summarizing, or failed/summarization with p_refusal, in one transaction; fenced on the live step token and on the meeting being transcribing (ADR-0012).';

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.append_segments(uuid, uuid, integer, jsonb, jsonb)',
    'public.finish_transcription(uuid, uuid, jsonb, text)'
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
