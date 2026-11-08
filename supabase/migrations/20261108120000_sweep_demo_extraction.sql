-- The cron sweeper finishes a summary the operator asked to make again on the public demo
-- (ADR-0011's resummarize addendum). `POST .../resummarize` moves a finished meeting back to
-- extraction, and no page drives the demo (ADR-0015), so without a tick its summary would
-- never be written. Every other meeting is chosen as before.
--
-- 1. sweep_can_extract answers whether an extraction step of one meeting can be taken now:
--    the `summarizing`/`indexing` branch of sweep_can_move, alone. A deliberate mirror of
--    `sweepCanExtract` in server/utils/db/pipeline.ts and of `unattendedStep` with
--    `only: 'extraction'` in server/utils/pipeline/assess.ts, and the parity tests hold them
--    together. sweep_can_move keeps its own copy of the branch, so it is not replaced here.
-- 2. sweep_next_meeting asks only that of the demo, where it used to leave the demo out. The
--    rest of it is as 20261103180000_sweeper.sql wrote it: the same reads, the same rotation.
--
-- Safe to run again: both functions replace themselves, and nothing here touches a row.

create or replace function public.sweep_can_extract(
  p_meeting uuid,
  p_status  text,
  p_busy    text[],
  p_now     timestamptz
)
returns boolean
language plpgsql
stable
set search_path = public
as $$
declare
  v_run public.pipeline_runs;
begin
  if p_status not in ('summarizing', 'indexing') then
    return false;
  end if;
  select * into v_run from public.pipeline_runs r where r.meeting_id = p_meeting and r.stage = 'summarization';
  return (v_run.step_lease_until is null or v_run.step_lease_until <= p_now)
     and (v_run.retry_at is null or v_run.retry_at <= p_now)
     -- Planning and finalizing ask no provider. Only a chunk does.
     and (not ('groq-chat' = any (p_busy))
          or not exists (select 1 from public.summary_chunks c
                          where c.meeting_id = p_meeting and c.run_id = v_run.run_id and c.result is null));
end
$$;

comment on function public.sweep_can_extract(uuid, text, text[], timestamptz) is
  'Whether the cron sweeper can take an extraction step of this meeting now, which is all it asks of the public demo. Mirrors sweepCanExtract in pipeline.ts (ADR-0011, ADR-0012).';

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
  -- meeting in progress waits for those ahead of it to move, or for a tab. A finished
  -- transcript waits for a tab alone: a complete meeting's row never moves again, so
  -- those ahead of it stay ahead. One step from a tab brings it back to the front.
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
   -- The demo has only its extraction taken: neither its transcript nor its index moves.
   where case when c.id is distinct from p_exclude
              then public.sweep_can_move(c.id, c.status, c.failed_stage, p_model, p_limit_error, v_busy, v_now)
              else public.sweep_can_extract(c.id, c.status, v_busy, v_now) end
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
  'Choose the next meeting the cron sweeper can move, moving the rotation on, and say which providers cannot be asked now. Reads a fixed number of meetings, and asks only for an extraction step of the public demo (ADR-0011, ADR-0012).';

-- A new function starts with EXECUTE for PUBLIC, and on Supabase for its API roles.
-- Only the service role reaches these. Guarded, because a plain Postgres has none of
-- these roles.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sweep_can_extract(uuid, text, text[], timestamptz)',
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
