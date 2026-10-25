-- What step-wise extraction needs from the run ledger (ADR-0012, step 6).
--
-- 1. claim_step can move the meeting into the stage it claims for, in the same
--    transaction (p_move_to). Entering extraction from `summarizing`, from a
--    cooled-down `failed`, or from `ready` with no summary row is then one
--    write: a separate status compare-and-swap after the claim left a window
--    where a crash stranded the meeting `indexing` with no plan of the new run.
-- 2. release_step can replace the run's cursor (p_cursor). Three consecutive
--    429s on one chunk end the run (ADR §5), and that count has to survive
--    between requests, written under the step's token like everything else.
-- 3. release_step can fail the meeting under the step's token (p_fail_from).
--    A step whose lease ran out while it waited on the provider must not move
--    the meeting to `failed` under a step that re-claimed it meanwhile; a
--    status write fenced only on the status could not tell the two apart.
-- 4. claim_step can redo a chunk whose stored result no longer passes the
--    read-back check (p_redo). The reader treats such a result as missing, so
--    a claim that refused it as "already done" left the run asking for that
--    chunk forever. A redo claim clears the result with the claim.

drop function public.claim_step(uuid, text, text, integer, integer, boolean, boolean);
drop function public.release_step(uuid, text, uuid, text, timestamptz, boolean);

create function public.claim_step(
  p_meeting        uuid,
  p_stage          text,
  p_status         text,
  p_lease_ms       integer,
  p_chunk_no       integer default null,
  p_new_run        boolean default false,
  p_reset_attempts boolean default false,
  p_move_to        text default null,
  p_redo           boolean default false
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

comment on function public.claim_step(uuid, text, text, integer, integer, boolean, boolean, text, boolean) is
  'Claim the next step of a pipeline stage under a fresh token and a short lease, if none is live, the meeting is in p_status and the chunk (if any) has no result yet (or p_redo clears an unusable one); optionally moving the meeting to p_move_to (ADR-0012).';

-- End a step without a result. p_refund_attempt gives back the attempt the
-- claim counted (no provider call was made); p_cursor replaces the run's
-- cursor; p_fail_from moves the meeting to `failed` for this stage, if it is
-- still in that status.
create function public.release_step(
  p_meeting        uuid,
  p_stage          text,
  p_token          uuid,
  p_error          text,
  p_retry_at       timestamptz,
  p_refund_attempt boolean default false,
  p_cursor         jsonb default null,
  p_fail_from      text default null
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_run public.pipeline_runs;
begin
  if p_cursor is not null and jsonb_typeof(p_cursor) is distinct from 'object' then
    raise exception 'release_step: the cursor must be a JSON object' using errcode = '22023';
  end if;
  -- Only these stages have a failed_stage of their own; indexing failures never
  -- touch the meeting's status (ADR §5).
  if p_fail_from is not null and p_stage not in ('transcription', 'summarization') then
    raise exception 'release_step: the % stage cannot fail the meeting', p_stage using errcode = '22023';
  end if;

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
         cursor     = coalesce(p_cursor, r.cursor),
         last_error = p_error, retry_at = p_retry_at, updated_at = clock_timestamp()
   where r.meeting_id = p_meeting and r.stage = p_stage;

  if p_fail_from is not null then
    update public.meetings m
       set status = 'failed', failed_stage = p_stage,
           error_message = coalesce(p_error, 'The ' || p_stage || ' step failed')
     where m.id = p_meeting and m.status = p_fail_from;
  end if;
  return true;
end
$$;

comment on function public.release_step(uuid, text, uuid, text, timestamptz, boolean, jsonb, text) is
  'Give up a step''s lease without a result, recording why and when to try again; optionally refunding its attempt, replacing the run''s cursor and failing the meeting, all under the step''s token (ADR-0012).';

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.claim_step(uuid, text, text, integer, integer, boolean, boolean, text, boolean)',
    'public.release_step(uuid, text, uuid, text, timestamptz, boolean, jsonb, text)'
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
