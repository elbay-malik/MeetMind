-- What the cron sweeper needs (ADR-0012, step 11): one meeting that can move, chosen by the
-- database, in one request, however many meetings there are.
--
-- 1. sweep_state is one row: when the last tick ran, and which meeting it chose. Choosing
--    moves it on in the same transaction, so rotation survives a tick killed straight after,
--    which is the case a stuck meeting would otherwise win every time. It is also what a
--    tick with nothing to do writes, as Phase 13's keep-alive.
-- 2. Two partial indexes, so choosing reads a fixed number of meetings: the 50 in progress
--    that have waited longest, and the 50 finished transcripts touched most recently.
-- 3. sweep_can_move answers for one meeting. It is a deliberate mirror of `unattendedStep`
--    in server/utils/pipeline/assess.ts and of `sweepCanMove` in server/utils/db/pipeline.ts,
--    and the parity tests hold them together.
-- 4. sweep_next_meeting moves the row on and answers.
--
-- Safe to run again: everything is conditional or replaces itself, and nothing here
-- touches a row that already exists.

create table if not exists public.sweep_state (
  -- Always true: there is one row, and the primary key says so.
  id              boolean primary key default true check (id),
  -- The last tick to reach the database, whether or not it found anything.
  last_tick_at    timestamptz not null default now(),
  -- The last meeting chosen. Not a foreign key: a deleted meeting still says where the
  -- rotation had got to, and nothing is ever read through these.
  last_created_at timestamptz,
  last_meeting_id uuid
);

comment on table public.sweep_state is
  'Where the cron sweeper''s rotation has got to, and when it last ran. One row (ADR-0012).';

insert into public.sweep_state (id) values (true) on conflict (id) do nothing;

-- Same posture as every other table: only the service role reaches this.
alter table public.sweep_state enable row level security;

-- Oldest first: a claim moves updated_at, so what has just had a step goes to the back.
create index if not exists meetings_in_progress_idx
  on public.meetings (updated_at, id)
  where status in ('uploaded', 'transcribing', 'summarizing', 'indexing');

-- Newest first: this list only grows, and what is left of an index is on what moved last.
create index if not exists meetings_transcript_finished_idx
  on public.meetings (updated_at desc, id)
  where status = 'ready' or (status = 'failed' and failed_stage = 'summarization');

-- Whether a step of this meeting can be taken now, with nobody watching. Reads the meeting's
-- own rows only, by key, and none of a transcript's text: a hash of the transcript would
-- cost a read of every line, so a complete marker counts as settled whatever it holds.
--
-- It never answers true for a retry of a failed stage, nor for a provider that is blocked
-- or whose next slot is not free now.
create or replace function public.sweep_can_move(
  p_meeting      uuid,
  p_status       text,
  p_failed_stage text,
  p_model        text,
  p_limit_error  text,
  p_busy         text[],
  p_now          timestamptz
)
returns boolean
language plpgsql
stable
set search_path = public
as $$
declare
  v_run public.pipeline_runs;
  v_index public.pipeline_runs;
  v_marker public.meeting_index_state;
begin
  if p_status = 'uploaded' then
    return not ('groq-whisper' = any (p_busy));
  end if;

  if p_status = 'transcribing' then
    select * into v_run from public.pipeline_runs r where r.meeting_id = p_meeting and r.stage = 'transcription';
    if v_run.step_lease_until > p_now or v_run.retry_at > p_now then
      return false;
    end if;
    -- A page of a stored reply asks no provider.
    return (v_run.cursor -> 'reply') is not null or not ('groq-whisper' = any (p_busy));
  end if;

  if p_status in ('summarizing', 'indexing') then
    select * into v_run from public.pipeline_runs r where r.meeting_id = p_meeting and r.stage = 'summarization';
    if (v_run.step_lease_until is null or v_run.step_lease_until <= p_now)
       and (v_run.retry_at is null or v_run.retry_at <= p_now)
       -- Planning and finalizing ask no provider. Only a chunk does.
       and (not ('groq-chat' = any (p_busy))
            or not exists (select 1 from public.summary_chunks c
                            where c.meeting_id = p_meeting and c.run_id = v_run.run_id and c.result is null)) then
      return true;
    end if;
  elsif not (p_status = 'ready' or (p_status = 'failed' and p_failed_stage = 'summarization')) then
    return false;
  end if;

  -- The index, which is what is left of any of the statuses above.
  if 'workers-ai-embed' = any (p_busy) then
    return false;
  end if;

  select * into v_marker from public.meeting_index_state x where x.meeting_id = p_meeting;
  -- Finished, or finished for another model or transcript, which only an explicit request replaces.
  if v_marker.complete or v_marker.model <> p_model then
    return false;
  end if;

  select * into v_index from public.pipeline_runs r where r.meeting_id = p_meeting and r.stage = 'search_index';
  if v_index.step_lease_until > p_now or v_index.retry_at > p_now then
    return false;
  end if;
  -- An index has no `failed` to stop in, so a stored error is that. Only the daily limit,
  -- with its time passed, has an end by itself.
  if v_index.last_error is not null and (v_index.last_error is distinct from p_limit_error or v_index.retry_at is null) then
    return false;
  end if;
  if (v_index.cursor -> 'pass' ->> 'model') <> p_model then
    return false;
  end if;

  if exists (select 1 from public.transcript_windows w where w.meeting_id = p_meeting and w.model <> p_model) then
    return false;
  end if;
  -- No lines and nothing stored is an index finished with nothing in it.
  return exists (select 1 from public.transcript_segments s where s.meeting_id = p_meeting)
      or exists (select 1 from public.transcript_windows w where w.meeting_id = p_meeting);
end
$$;

comment on function public.sweep_can_move(uuid, text, text, text, text, text[], timestamptz) is
  'Whether the cron sweeper can take a step of this meeting now. Mirrors unattendedStep in assess.ts (ADR-0012).';

-- Always exactly one row: a meeting, or a null id when none can move, and which providers
-- cannot be asked right now. Which of the two it is, a real write has reached Postgres.
create or replace function public.sweep_next_meeting(
  p_model       text,
  p_exclude     uuid,
  p_limit_error text
)
returns table (meeting_id uuid, busy text[])
language plpgsql
set search_path = public
as $$
declare
  v_now timestamptz;
  v_last_created timestamptz;
  v_last_id uuid;
  v_busy text[];
  v_id uuid;
  v_created timestamptz;
begin
  if p_model is null or length(p_model) = 0 then
    raise exception 'sweep_next_meeting: a model is required' using errcode = '22023';
  end if;

  -- First, and the lock it takes lasts until this returns: two ticks at once wait here
  -- and come away with different meetings.
  insert into public.sweep_state (id) values (true) on conflict (id) do nothing;
  update public.sweep_state s set last_tick_at = clock_timestamp()
   where s.id
  returning s.last_tick_at, s.last_created_at, s.last_meeting_id into v_now, v_last_created, v_last_id;

  -- What reserve_slot would refuse at no wait. Whisper takes no slot, only a block.
  select coalesce(array_agg(s.provider order by s.provider), '{}') into v_busy
    from public.provider_slots s
   where case when s.provider = 'groq-whisper' then s.blocked_until
              else greatest(s.next_available_at, s.blocked_until) end > v_now;

  -- At most 100 meetings, each read by key, whatever the table holds. Past those, a
  -- meeting waits for those ahead of it to move, or for a tab.
  select c.id, c.created_at into v_id, v_created
    from (
      (select m.id, m.created_at, m.status, m.failed_stage
         from public.meetings m
        where m.status in ('uploaded', 'transcribing', 'summarizing', 'indexing')
        order by m.updated_at, m.id
        limit 50)
      union all
      (select m.id, m.created_at, m.status, m.failed_stage
         from public.meetings m
        where m.status = 'ready' or (m.status = 'failed' and m.failed_stage = 'summarization')
        order by m.updated_at desc, m.id
        limit 50)
    ) c
   where c.id is distinct from p_exclude
     and public.sweep_can_move(c.id, c.status, c.failed_stage, p_model, p_limit_error, v_busy, v_now)
   -- The rotation: whatever comes after the last one chosen, then back to the first.
   order by case when v_last_created is null or (c.created_at, c.id) > (v_last_created, v_last_id) then 0 else 1 end,
            c.created_at, c.id
   limit 1;

  if v_id is not null then
    update public.sweep_state s set last_created_at = v_created, last_meeting_id = v_id where s.id;
  end if;
  return query select v_id, v_busy;
end
$$;

comment on function public.sweep_next_meeting(text, uuid, text) is
  'Choose the next meeting the cron sweeper can move, moving the rotation on, and say which providers cannot be asked now. Reads a fixed number of meetings (ADR-0012).';

-- A new function starts with EXECUTE for PUBLIC, and on Supabase for its API roles.
-- Only the service role reaches these. Guarded, because a plain Postgres has none of
-- these roles.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sweep_can_move(uuid, text, text, text, text, text[], timestamptz)',
    'public.sweep_next_meeting(text, uuid, text)'
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
