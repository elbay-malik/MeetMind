-- A meeting whose extraction failed pauses the demo's questions for an hour after its row last
-- changed, and no longer for as long as it stays failed (ADR-0019). A meeting summarizing or
-- indexing pauses them exactly as before, however long ago it last moved.
--
-- A failed row may never ask for a slot again, and nothing retries one by itself, so without a
-- bound one ordinary failure paused the demo until someone retried or deleted that meeting. A
-- retry moves the row to `summarizing`, which pauses the demo again at once, and a retry that
-- fails again moves `updated_at`, which starts a new hour. So the bound only ends a pause for a
-- row nobody is acting on.
--
-- 1. The one partial index on all three states becomes two: one on the states in progress, as
--    before, and one on the failed rows by `updated_at`, so the gate reads only those inside the
--    hour however many older ones there are.
-- 2. demo_question_gate is replaced with the same arguments, result and grants. Only its
--    question about extraction changes. `pausesDemoQuestions` in shared/utils/meeting.ts is the
--    local driver's copy, and tests/unit/helpers/demo-question-cases.ts holds the two together.
--
-- Safe to run again: everything is conditional or replaces itself, and no count is touched.

drop index if exists public.meetings_extraction_pending_idx;

create index if not exists meetings_extraction_running_idx
  on public.meetings (id)
  where status in ('summarizing', 'indexing');

create index if not exists meetings_extraction_failed_idx
  on public.meetings (updated_at)
  where status = 'failed' and failed_stage = 'summarization';

-- Two EXISTS, one per index, rather than one over an OR: each WHERE is its index's own, so each
-- is answered from that index alone. The hour is `now()`, the transaction's start, which for a
-- read of one statement is the same moment.
create or replace function public.demo_question_gate(
  p_limit integer,
  p_demo  uuid
)
returns table (over_count boolean, extraction_pending boolean)
language plpgsql
stable
set search_path = public
as $$
declare
  v_taken integer;
begin
  -- Neither has a safe reading. No limit would compare as nothing being over it, and no demo as
  -- nothing else being in progress: either one would open the cap by mistake.
  if p_limit is null then
    raise exception 'demo_question_gate: the limit must be given' using errcode = '22023';
  end if;
  if p_demo is null then
    raise exception 'demo_question_gate: the public demo must be named' using errcode = '22023';
  end if;

  select d.taken into v_taken
    from public.demo_question_days d
   where d.day = (now() at time zone 'utc')::date;

  return query select
    coalesce(v_taken, 0) >= p_limit,
    exists (
      select 1
        from public.meetings m
       where m.status in ('summarizing', 'indexing')
         and m.id <> p_demo
    ) or exists (
      select 1
        from public.meetings m
       where m.status = 'failed' and m.failed_stage = 'summarization'
         and m.updated_at > now() - interval '1 hour'
         and m.id <> p_demo
    );
end
$$;

comment on function public.demo_question_gate(integer, uuid) is
  'Reads whether the demo is over its daily count, and whether any other meeting is summarizing or indexing, or failed at extraction within the last hour. Writes nothing (ADR-0019).';

-- Replacing a function keeps its grants. Said again anyway, so the posture holds however this
-- file meets the database, guarded as before for a plain Postgres with none of these roles.
do $$
begin
  revoke all on function public.demo_question_gate(integer, uuid) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.demo_question_gate(integer, uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.demo_question_gate(integer, uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.demo_question_gate(integer, uuid) to service_role;
  end if;
end $$;
