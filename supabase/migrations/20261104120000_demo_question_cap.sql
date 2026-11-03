-- A daily cap on questions asked of the public demo meeting, and a way to see that an
-- extraction is pending (ADR-0019). Asking the demo is open to anyone, and a question spends
-- Groq's 200,000 tokens a day and can hold a provider slot ahead of extraction. Only the
-- service role reaches any of this, and only for the demo: other meetings' questions never call it.
--
-- 1. demo_question_days holds one count per UTC day. Taking a question deletes earlier days,
--    so the table never holds more than a day or two.
-- 2. A partial index on what counts as an extraction in progress, so asking whether there is one
--    reads a row or two however many meetings there are.
-- 3. demo_question_gate reads, before a provider slot is reserved, since reserving one is itself
--    what stalls extraction. It writes nothing, so a loop of refused requests burns nothing.
-- 4. take_demo_question counts one, after the slot was granted and before anything is spent.
--
-- Safe to run again: everything is conditional or replaces itself, and a count is kept.

create table if not exists public.demo_question_days (
  day   date primary key,
  taken integer not null default 0 check (taken >= 0)
);

comment on table public.demo_question_days is
  'Questions taken on the public demo meeting, by UTC day. Earlier days are deleted by the next take (ADR-0019).';

alter table public.demo_question_days enable row level security;

-- `meetings_transcript_finished_idx` is close, and has every ready meeting in it: this one has
-- only what is in progress, so a table of any size costs the same. The WHERE is the function's
-- below, word for word, and `extractionInProgress` in shared/utils/meeting.ts: the parity
-- cases in tests/unit/helpers/demo-question-cases.ts hold them together.
create index if not exists meetings_extraction_pending_idx
  on public.meetings (id)
  where status in ('summarizing', 'indexing') or (status = 'failed' and failed_stage = 'summarization');

-- Whether a question on the demo may go on to reserve a slot, reading only. Today's count, by
-- key, and at most two rows of the index: the demo's own, and one other.
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
       where (m.status in ('summarizing', 'indexing') or (m.status = 'failed' and m.failed_stage = 'summarization'))
         and m.id <> p_demo
    );
end
$$;

comment on function public.demo_question_gate(integer, uuid) is
  'Reads whether the demo is over its daily count, and whether any other meeting has an extraction in progress. Writes nothing (ADR-0019).';

-- Take one of today's questions, if any are left. One statement decides it: concurrent callers
-- queue on the row, and Postgres checks the WHERE again against the row each one finally sees,
-- so a limit of N grants exactly N. clock_timestamp(), like reserve_slot, as a caller that
-- waited on the lock across midnight belongs to the new day.
create or replace function public.take_demo_question(
  p_limit integer
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_day date := (clock_timestamp() at time zone 'utc')::date;
begin
  if p_limit is null then
    raise exception 'take_demo_question: the limit must be given' using errcode = '22023';
  end if;
  if p_limit <= 0 then
    return false;
  end if;

  delete from public.demo_question_days where day < v_day;

  insert into public.demo_question_days as d (day, taken)
  values (v_day, 1)
  on conflict (day) do update
    set taken = d.taken + 1
    where d.taken < p_limit;

  return found;
end
$$;

comment on function public.take_demo_question(integer) is
  'Counts one question on the demo today if the limit allows, and answers whether it did. Deletes earlier days (ADR-0019).';

-- A new function starts with EXECUTE for PUBLIC, and on Supabase for its API roles, and a new
-- table with the API roles' grants. Only the service role reaches these. Guarded, because a
-- plain Postgres has none of these roles.
do $$
begin
  revoke all on function public.demo_question_gate(integer, uuid) from public;
  revoke all on function public.take_demo_question(integer) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.demo_question_gate(integer, uuid) from anon;
    revoke all on function public.take_demo_question(integer) from anon;
    revoke all on table public.demo_question_days from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.demo_question_gate(integer, uuid) from authenticated;
    revoke all on function public.take_demo_question(integer) from authenticated;
    revoke all on table public.demo_question_days from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.demo_question_gate(integer, uuid) to service_role;
    grant execute on function public.take_demo_question(integer) to service_role;
    grant select, insert, update, delete on table public.demo_question_days to service_role;
  end if;
end $$;
