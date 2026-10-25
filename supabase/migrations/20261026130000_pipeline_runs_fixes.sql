-- Fixes to the run ledger found in review, before anything calls it (ADR-0012,
-- step 5 addendum).
--
-- 1. One lock order. claim_step and the fenced delete lock the meeting row and
--    then the run row; the token-fenced writes locked the run row and then the
--    meeting. A write by a step whose lease had just run out, racing a
--    re-claim, deadlocked (40P01). Every write now locks the meeting first.
-- 2. Attempts that no provider call spent can be given back. A step claims,
--    THEN reserves its request slot; a slot miss or a 429 parks the step
--    without a call, and must not use up the chunk's attempts (ADR §5).
--    release_step can refund the claim's attempt, and claim_step can restart
--    the count when a failed run is retried.
-- 3. A chunk that already has its result is not claimed again, so two drivers
--    racing on the same chunk spend one provider call, not two.
-- 4. record_chunk takes the chunk's segment range and refuses a mismatch, so a
--    result is only ever checked against the range it is stored under.

-- Which chunk the live step claimed, so a release knows whose attempt to refund.
alter table public.pipeline_runs add column step_chunk_no integer;
alter table public.pipeline_runs add constraint pipeline_runs_chunk_needs_step
  check (step_token is not null or step_chunk_no is null);

drop function public.claim_step(uuid, text, text, integer, integer, boolean);
drop function public.release_step(uuid, text, uuid, text, timestamptz);
drop function public.record_chunk(uuid, uuid, integer, jsonb);

-- The shared fence, now taking the meeting's lock before the run row's.
create or replace function public.locked_step_run(p_meeting uuid, p_stage text, p_token uuid)
returns public.pipeline_runs
language plpgsql
set search_path = public
as $$
declare
  v_run public.pipeline_runs;
begin
  perform 1 from public.meetings m where m.id = p_meeting for update;
  select r.* into v_run from public.pipeline_runs r
   where r.meeting_id = p_meeting and r.stage = p_stage and r.step_token = p_token
   for update;
  return v_run;
end
$$;

create function public.claim_step(
  p_meeting        uuid,
  p_stage          text,
  p_status         text,
  p_lease_ms       integer,
  p_chunk_no       integer default null,
  p_new_run        boolean default false,
  p_reset_attempts boolean default false
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

  perform 1 from public.meetings m where m.id = p_meeting and m.status = p_status for update;
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
    if v_result is not null then
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
       set attempts = case when p_reset_attempts then 1 else c.attempts + 1 end, updated_at = clock_timestamp()
     where c.meeting_id = p_meeting and c.chunk_no = p_chunk_no and c.run_id = v_run.run_id
    returning c.attempts into v_attempts;
  end if;

  update public.meetings m set updated_at = clock_timestamp() where m.id = p_meeting;

  return query select v_run.step_token, v_run.run_id, v_run.cursor, v_attempts;
end
$$;

comment on function public.claim_step(uuid, text, text, integer, integer, boolean, boolean) is
  'Claim the next step of a pipeline stage under a fresh token and a short lease, if none is live, the meeting is in p_status and the chunk (if any) has no result yet (ADR-0012).';

-- End a step without a result. With p_refund_attempt, the attempt the claim
-- counted is given back: the step made no provider call (a slot miss, a 429).
create function public.release_step(
  p_meeting        uuid,
  p_stage          text,
  p_token          uuid,
  p_error          text,
  p_retry_at       timestamptz,
  p_refund_attempt boolean default false
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_run public.pipeline_runs;
begin
  v_run := public.locked_step_run(p_meeting, p_stage, p_token);
  if v_run.meeting_id is null then
    return false;
  end if;

  if p_refund_attempt and v_run.step_chunk_no is not null then
    update public.summary_chunks c
       set attempts = greatest(c.attempts - 1, 0), updated_at = clock_timestamp()
     where c.meeting_id = p_meeting and c.chunk_no = v_run.step_chunk_no and c.run_id = v_run.run_id;
  end if;

  update public.pipeline_runs r
     set step_token = null, step_lease_until = null, step_chunk_no = null,
         attempts   = case when p_refund_attempt and v_run.step_chunk_no is null
                           then greatest(r.attempts - 1, 0) else r.attempts end,
         last_error = p_error, retry_at = p_retry_at, updated_at = clock_timestamp()
   where r.meeting_id = p_meeting and r.stage = p_stage;
  return true;
end
$$;

comment on function public.release_step(uuid, text, uuid, text, timestamptz, boolean) is
  'Give up a step''s lease without a result, recording why and when to try again, and optionally refunding its attempt (ADR-0012).';

create function public.record_chunk(
  p_meeting  uuid,
  p_token    uuid,
  p_chunk_no integer,
  p_seg_from integer,
  p_seg_to   integer,
  p_result   jsonb
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_run public.pipeline_runs;
begin
  if jsonb_typeof(p_result) is distinct from 'object' then
    raise exception 'record_chunk: the result must be a JSON object' using errcode = '22023';
  end if;

  v_run := public.locked_step_run(p_meeting, 'summarization', p_token);
  if v_run.meeting_id is null then
    return false;
  end if;

  update public.summary_chunks c
     set result = p_result, updated_at = clock_timestamp()
   where c.meeting_id = p_meeting and c.chunk_no = p_chunk_no and c.run_id = v_run.run_id
     and c.seg_from = p_seg_from and c.seg_to = p_seg_to;
  if not found then
    return false;
  end if;

  update public.pipeline_runs r
     set step_token = null, step_lease_until = null, step_chunk_no = null,
         last_error = null, retry_at = null, updated_at = clock_timestamp()
   where r.meeting_id = p_meeting and r.stage = 'summarization';
  return true;
end
$$;

comment on function public.record_chunk(uuid, uuid, integer, integer, integer, jsonb) is
  'Store one chunk''s attested result and end the step, if the chunk is planned with exactly this segment range; fenced on the live step token (ADR-0012).';

-- finalize_summary ends the step too: clear the claimed chunk alongside the
-- token, or the constraint above refuses the update.
create or replace function public.finalize_summary(
  p_meeting      uuid,
  p_token        uuid,
  p_summary      text,
  p_provider     text,
  p_decisions    jsonb,
  p_action_items jsonb
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_run public.pipeline_runs;
begin
  if jsonb_typeof(p_decisions) is distinct from 'array' or jsonb_typeof(p_action_items) is distinct from 'array' then
    raise exception 'finalize_summary: decisions and action items must be JSON arrays' using errcode = '22023';
  end if;

  v_run := public.locked_step_run(p_meeting, 'summarization', p_token);
  if v_run.meeting_id is null then
    return false;
  end if;

  if exists (select 1 from public.summary_chunks c
              where c.meeting_id = p_meeting and c.run_id = v_run.run_id and c.result is null) then
    raise exception 'finalize_summary: a chunk of the current plan has no result yet' using errcode = '55000';
  end if;

  update public.meetings m
     set status = 'ready', error_message = null, failed_stage = null
   where m.id = p_meeting and m.status = 'indexing';
  if not found then
    return false;
  end if;

  delete from public.meeting_decisions d where d.meeting_id = p_meeting;
  delete from public.meeting_action_items a where a.meeting_id = p_meeting;

  insert into public.meeting_summaries (meeting_id, summary, provider)
  values (p_meeting, p_summary, p_provider)
  on conflict (meeting_id) do update set summary = excluded.summary, provider = excluded.provider;

  insert into public.meeting_decisions (meeting_id, idx, decision, quote, segment_idx, start_ms)
  select p_meeting, x.idx, x.decision, x.quote, x.segment_idx, x.start_ms
    from jsonb_to_recordset(p_decisions)
      as x(idx integer, decision text, quote text, segment_idx integer, start_ms integer);

  insert into public.meeting_action_items (meeting_id, idx, task, assignee, due_date_text, quote, segment_idx, start_ms)
  select p_meeting, x.idx, x.task, x.assignee, x.due_date_text, x.quote, x.segment_idx, x.start_ms
    from jsonb_to_recordset(p_action_items)
      as x(idx integer, task text, assignee text, due_date_text text, quote text, segment_idx integer, start_ms integer);

  update public.pipeline_runs r
     set step_token = null, step_lease_until = null, step_chunk_no = null,
         last_error = null, retry_at = null, updated_at = clock_timestamp()
   where r.meeting_id = p_meeting and r.stage = 'summarization';
  return true;
end
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.claim_step(uuid, text, text, integer, integer, boolean, boolean)',
    'public.release_step(uuid, text, uuid, text, timestamptz, boolean)',
    'public.locked_step_run(uuid, text, uuid)',
    'public.record_chunk(uuid, uuid, integer, integer, integer, jsonb)',
    'public.finalize_summary(uuid, uuid, text, text, jsonb, jsonb)'
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
