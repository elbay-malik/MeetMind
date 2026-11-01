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
--
-- 3. claim_step can require the meeting to be as the caller read it
--    (p_expected_updated_at). A retry out of `failed` checks the failed stage and
--    the cooldown on an earlier read, and `failed` alone does not say which
--    failure this is: a stale retry could otherwise reopen a meeting whose
--    transcript another caller finished, or skip a cooldown that just restarted.

drop function public.claim_step(uuid, text, text, integer, integer, boolean, boolean, text, boolean);

create function public.claim_step(
  p_meeting        uuid,
  p_stage          text,
  p_status         text,
  p_lease_ms       integer,
  p_chunk_no       integer default null,
  p_new_run        boolean default false,
  p_reset_attempts boolean default false,
  p_move_to        text default null,
  p_redo           boolean default false,
  p_expected_updated_at timestamptz default null
)
returns table (step_token uuid, run_id uuid, run_cursor jsonb, attempts integer)
language plpgsql
set search_path = public
as $$
#variable_conflict use_column
declare
  v_run public.pipeline_runs%rowtype;
  v_result jsonb;
  v_attempts integer;
begin
  if p_lease_ms is null or p_lease_ms <= 0 then
    raise exception 'claim_step: the lease must be positive, got %', p_lease_ms using errcode = '22023';
  end if;
  if p_chunk_no is not null and p_new_run then
    raise exception 'claim_step: a new run has no chunks to claim yet' using errcode = '22023';
  end if;

  perform 1 from public.meetings m
   where m.id = p_meeting and m.status = p_status
     and (p_expected_updated_at is null or m.updated_at = p_expected_updated_at)
     for update;
  if not found then
    return;
  end if;

  insert into public.pipeline_runs (meeting_id, stage) values (p_meeting, p_stage)
  on conflict (meeting_id, stage) do nothing;

  select r.* into v_run from public.pipeline_runs r
   where r.meeting_id = p_meeting and r.stage = p_stage
     and (r.step_lease_until is null or r.step_lease_until < clock_timestamp())
   for update;
  if not found then
    return;
  end if;

  -- Checked before anything is written, so a refused chunk claim changes nothing.
  if p_chunk_no is not null then
    select c.result into v_result from public.summary_chunks c
     where c.meeting_id = p_meeting and c.chunk_no = p_chunk_no and c.run_id = v_run.run_id
     for update;
    if not found then
      raise exception 'claim_step: chunk % is not in the current plan', p_chunk_no using errcode = 'P0002';
    end if;
    if v_result is not null and not p_redo then
      return;
    end if;
  end if;

  update public.pipeline_runs r
     set step_token       = gen_random_uuid(),
         step_lease_until = clock_timestamp() + make_interval(secs => p_lease_ms / 1000.0),
         step_chunk_no    = p_chunk_no,
         run_id           = case when p_new_run then gen_random_uuid() else r.run_id end,
         cursor           = case when p_new_run then '{}'::jsonb else r.cursor end,
         last_error       = case when p_new_run then null else r.last_error end,
         retry_at         = case when p_new_run then null else r.retry_at end,
         attempts         = case
                              when p_new_run or p_chunk_no is not null then 0
                              when p_reset_attempts then 1
                              else r.attempts + 1
                            end,
         updated_at       = clock_timestamp()
   where r.meeting_id = p_meeting and r.stage = p_stage
  returning r.* into v_run;

  v_attempts := v_run.attempts;
  if p_chunk_no is not null then
    update public.summary_chunks c
       set attempts   = case when p_reset_attempts then 1 else c.attempts + 1 end,
           result     = case when p_redo then null else c.result end,
           updated_at = clock_timestamp()
     where c.meeting_id = p_meeting and c.chunk_no = p_chunk_no and c.run_id = v_run.run_id
    returning c.attempts into v_attempts;
  end if;

  -- Entering the stage clears the failure that left it, as the routes' own
  -- status claims always have.
  update public.meetings m
     set updated_at    = clock_timestamp(),
         status        = coalesce(p_move_to, m.status),
         error_message = case when p_move_to is null then m.error_message else null end,
         failed_stage  = case when p_move_to is null then m.failed_stage else null end
   where m.id = p_meeting;

  return query select v_run.step_token, v_run.run_id, v_run.cursor, v_attempts;
end
$$;

comment on function public.claim_step(uuid, text, text, integer, integer, boolean, boolean, text, boolean, timestamptz) is
  'Claim the next step of a pipeline stage under a fresh token and a short lease, if none is live, the meeting is in p_status (and unchanged since p_expected_updated_at, when given) and the chunk (if any) has no result yet (or p_redo clears an unusable one); optionally moving the meeting to p_move_to (ADR-0012).';

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
    'public.claim_step(uuid, text, text, integer, integer, boolean, boolean, text, boolean, timestamptz)',
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
