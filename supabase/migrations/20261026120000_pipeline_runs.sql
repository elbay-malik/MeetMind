-- The run ledger: where a meeting's pipeline is, step by step (ADR-0012 §3).
--
-- On Workers every invocation is short and may be killed at any moment, so a
-- stage can no longer be one long request holding a lease for hours. It becomes
-- a series of bounded steps, and what each finished step produced lives here.
-- Each step holds a short lease of its own, and every write it makes carries
-- its token: a step killed mid-flight leaves a lease that expires, the next
-- caller re-claims the step under a new token, and the killed step's late
-- writes match nothing.
create table public.pipeline_runs (
  meeting_id       uuid not null references public.meetings (id) on delete cascade,
  stage            text not null check (stage in ('transcription', 'summarization', 'search_index')),
  -- Changes when the stage starts over from nothing (a re-transcription), so
  -- results recorded under the old run are recognisably stale.
  run_id           uuid not null default gen_random_uuid(),
  -- Where the stage has got to, in whatever shape that stage needs.
  cursor           jsonb not null default '{}'::jsonb check (jsonb_typeof(cursor) = 'object'),
  -- The step in flight, if any: its token fences every write it makes.
  step_token       uuid,
  step_lease_until timestamptz,
  -- Claims of the current step, counted at the claim so a killed attempt counts.
  attempts         integer not null default 0 check (attempts >= 0),
  last_error       text,
  -- When the stage may next be tried, after a failure or a provider refusal.
  retry_at         timestamptz,
  updated_at       timestamptz not null default now(),
  primary key (meeting_id, stage),
  -- A token without a lease would never expire; a lease without a token
  -- fences nothing.
  constraint pipeline_runs_token_has_lease check ((step_token is null) = (step_lease_until is null))
);

comment on table public.pipeline_runs is
  'One row per meeting and pipeline stage: its progress and the lease of the step in flight (ADR-0012).';

-- One row per chunk of the extraction plan. `result` holds the ATTESTED items
-- for the chunk -- what survived the check against the chunk's own lines --
-- never the model's raw reply, so nothing unchecked is ever stored.
create table public.summary_chunks (
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  chunk_no   integer not null check (chunk_no >= 0),
  -- The summarization run this chunk was planned under. A chunk from an older
  -- run is stale and is never merged.
  run_id     uuid not null,
  seg_from   integer not null check (seg_from >= 0),
  seg_to     integer not null,
  est_tokens integer not null check (est_tokens >= 0),
  attempts   integer not null default 0 check (attempts >= 0),
  result     jsonb check (result is null or jsonb_typeof(result) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (meeting_id, chunk_no),
  check (seg_to >= seg_from)
);

comment on table public.summary_chunks is
  'The extraction plan, one row per chunk, with each finished chunk''s attested result (ADR-0012).';

-- Same posture as every other table: only the service role reaches these.
alter table public.pipeline_runs enable row level security;
alter table public.summary_chunks enable row level security;

-- Claim the next step of a stage, if no other step of it holds a live lease
-- and the meeting is still in the status the caller expects.
--
-- Returns one row (the new token, the run, its cursor and the attempt count
-- including this claim), or no row when the claim is refused. With p_chunk_no,
-- the attempt is counted on that chunk; with p_new_run, the stage starts over
-- under a new run id.
--
-- The meeting row is locked first and its updated_at moved: a delete fenced on
-- updated_at (ADR-0011) that read the meeting before this claim then finds it
-- changed and stops, and a delete that got there first leaves no row to lock.
create or replace function public.claim_step(
  p_meeting  uuid,
  p_stage    text,
  p_status   text,
  p_lease_ms integer,
  p_chunk_no integer default null,
  p_new_run  boolean default false
)
returns table (step_token uuid, run_id uuid, run_cursor jsonb, attempts integer)
language plpgsql
set search_path = public
as $$
#variable_conflict use_column
declare
  v_run public.pipeline_runs%rowtype;
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

  update public.pipeline_runs r
     set step_token       = gen_random_uuid(),
         step_lease_until = clock_timestamp() + make_interval(secs => p_lease_ms / 1000.0),
         run_id           = case when p_new_run then gen_random_uuid() else r.run_id end,
         cursor           = case when p_new_run then '{}'::jsonb else r.cursor end,
         last_error       = case when p_new_run then null else r.last_error end,
         retry_at         = case when p_new_run then null else r.retry_at end,
         attempts         = case when p_new_run or p_chunk_no is not null then 0 else r.attempts + 1 end,
         updated_at       = clock_timestamp()
   where r.meeting_id = p_meeting and r.stage = p_stage
     and (r.step_lease_until is null or r.step_lease_until < clock_timestamp())
  returning r.* into v_run;
  if not found then
    return;
  end if;

  v_attempts := v_run.attempts;
  if p_chunk_no is not null then
    update public.summary_chunks c
       set attempts = c.attempts + 1, updated_at = clock_timestamp()
     where c.meeting_id = p_meeting and c.chunk_no = p_chunk_no and c.run_id = v_run.run_id
    returning c.attempts into v_attempts;
    if not found then
      -- Raised, not returned empty: the whole claim rolls back, and a caller
      -- asking for a chunk the plan does not have has a bug to see.
      raise exception 'claim_step: chunk % is not in the current plan', p_chunk_no using errcode = 'P0002';
    end if;
  end if;

  update public.meetings m set updated_at = clock_timestamp() where m.id = p_meeting;

  return query select v_run.step_token, v_run.run_id, v_run.cursor, v_attempts;
end
$$;

comment on function public.claim_step(uuid, text, text, integer, integer, boolean) is
  'Claim the next step of a pipeline stage under a fresh token and a short lease, if none is live and the meeting is in p_status (ADR-0012).';

-- End a step without a result: a failure, or a provider that said "not yet".
-- The lease goes, so the next caller may claim at once; retry_at says when
-- that is worth doing. False when the token is no longer the live one.
create or replace function public.release_step(
  p_meeting  uuid,
  p_stage    text,
  p_token    uuid,
  p_error    text,
  p_retry_at timestamptz
)
returns boolean
language sql
set search_path = public
as $$
  with released as (
    update public.pipeline_runs r
       set step_token = null, step_lease_until = null,
           last_error = p_error, retry_at = p_retry_at, updated_at = clock_timestamp()
     where r.meeting_id = p_meeting and r.stage = p_stage and r.step_token = p_token
    returning 1
  )
  select exists (select 1 from released)
$$;

comment on function public.release_step(uuid, text, uuid, text, timestamptz) is
  'Give up a step''s lease without a result, recording why and when to try again (ADR-0012).';

-- Lock the stage's run row, but only while p_token is still its live step.
-- FOR UPDATE re-reads a row another transaction changed before granting the
-- lock, so a straggler whose step was re-claimed meanwhile finds no row.
create or replace function public.locked_step_run(p_meeting uuid, p_stage text, p_token uuid)
returns public.pipeline_runs
language sql
set search_path = public
as $$
  select r.* from public.pipeline_runs r
   where r.meeting_id = p_meeting and r.stage = p_stage and r.step_token = p_token
   for update
$$;

-- Write the extraction plan for the current summarization run. The step keeps
-- its token: planning makes no provider call, so the same step goes on to its
-- first chunk.
--
-- A plan already written for this run is left exactly as it is, results and
-- all, so a planning step that is retried redoes nothing. Chunks from an
-- earlier run are removed. False when the token is not the live one.
create or replace function public.plan_chunks(p_meeting uuid, p_token uuid, p_chunks jsonb)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_run public.pipeline_runs;
begin
  if jsonb_typeof(p_chunks) is distinct from 'array' then
    raise exception 'plan_chunks: the plan must be a JSON array' using errcode = '22023';
  end if;

  v_run := public.locked_step_run(p_meeting, 'summarization', p_token);
  if v_run.meeting_id is null then
    return false;
  end if;

  delete from public.summary_chunks c where c.meeting_id = p_meeting and c.run_id <> v_run.run_id;
  if exists (select 1 from public.summary_chunks c where c.meeting_id = p_meeting) then
    return true;
  end if;

  insert into public.summary_chunks (meeting_id, chunk_no, run_id, seg_from, seg_to, est_tokens)
  select p_meeting, x.chunk_no, v_run.run_id, x.seg_from, x.seg_to, x.est_tokens
    from jsonb_to_recordset(p_chunks) as x(chunk_no integer, seg_from integer, seg_to integer, est_tokens integer);
  return true;
end
$$;

comment on function public.plan_chunks(uuid, uuid, jsonb) is
  'Write the extraction plan for the current run, unless it already has one; fenced on the live step token (ADR-0012).';

-- Store one chunk's attested result and end the step. False when the token is
-- not the live one, or the chunk is not in the current run's plan; then
-- nothing is written.
create or replace function public.record_chunk(p_meeting uuid, p_token uuid, p_chunk_no integer, p_result jsonb)
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
   where c.meeting_id = p_meeting and c.chunk_no = p_chunk_no and c.run_id = v_run.run_id;
  if not found then
    return false;
  end if;

  update public.pipeline_runs r
     set step_token = null, step_lease_until = null, last_error = null, retry_at = null,
         updated_at = clock_timestamp()
   where r.meeting_id = p_meeting and r.stage = 'summarization';
  return true;
end
$$;

comment on function public.record_chunk(uuid, uuid, integer, jsonb) is
  'Store one chunk''s attested result and end the step; fenced on the live step token (ADR-0012).';

-- Write the merged summary and move the meeting from indexing to ready, in one
-- transaction: the summary, its decisions and action items, and the status
-- either all land or none do. This is what closes ADR-0006's "renew, then
-- write without a transaction" gap.
--
-- p_decisions and p_action_items are arrays of rows in the tables' own column
-- names. False, with nothing written, when the token is not the live one or
-- the meeting is no longer indexing. Refuses outright while a chunk of the
-- current plan has no result: merging then would silently lose that chunk.
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
     set step_token = null, step_lease_until = null, last_error = null, retry_at = null,
         updated_at = clock_timestamp()
   where r.meeting_id = p_meeting and r.stage = 'summarization';
  return true;
end
$$;

comment on function public.finalize_summary(uuid, uuid, text, text, jsonb, jsonb) is
  'Write the merged summary and move the meeting to ready in one transaction; fenced on the live step token (ADR-0012).';

-- Same posture as the other functions: the browser roles have no reason to call
-- these. Guarded, because a plain Postgres has none of these roles.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.claim_step(uuid, text, text, integer, integer, boolean)',
    'public.release_step(uuid, text, uuid, text, timestamptz)',
    'public.locked_step_run(uuid, text, uuid)',
    'public.plan_chunks(uuid, uuid, jsonb)',
    'public.record_chunk(uuid, uuid, integer, jsonb)',
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
