-- A daily count of questions on every meeting but the public demo, which keeps its own
-- (ADR-0020). A meeting's link is held by whoever registered it and whoever they gave it to, and
-- each question spends the answering and embedding providers' daily allowances that every
-- meeting shares. Only the service role reaches any of this.
--
-- The same shape as the demo's (20261104120000_demo_question_cap.sql), keyed by meeting too:
-- 1. meeting_question_days holds one count per UTC day and meeting. Taking a question deletes
--    earlier days, so the table never holds more than a day or two of the meetings asked.
-- 2. meeting_question_gate reads, before a provider slot is reserved, so a question over the
--    count holds no slot. It writes nothing.
-- 3. take_meeting_question counts one, after the slot was granted and before anything is spent.
--
-- Safe to run again: everything is conditional or replaces itself, and a count is kept.

-- The day first, so deleting earlier days is a range of the key. A count goes with its meeting,
-- as everything else stored for one does, and the index on the meeting is for that delete.
create table if not exists public.meeting_question_days (
  day        date not null,
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  taken      integer not null default 0 check (taken >= 0),
  primary key (day, meeting_id)
);

create index if not exists meeting_question_days_meeting_idx
  on public.meeting_question_days (meeting_id);

comment on table public.meeting_question_days is
  'Questions taken on each meeting other than the public demo, by UTC day. Earlier days are deleted by the next take (ADR-0020).';

alter table public.meeting_question_days enable row level security;

-- Whether a question on this meeting is over today's count, reading only, by key.
create or replace function public.meeting_question_gate(
  p_limit   integer,
  p_meeting uuid
)
returns boolean
language plpgsql
stable
set search_path = public
as $$
declare
  v_taken integer;
begin
  -- Neither has a safe reading: no limit would compare as nothing being over it, and no meeting
  -- would read a count nobody keeps.
  if p_limit is null then
    raise exception 'meeting_question_gate: the limit must be given' using errcode = '22023';
  end if;
  if p_meeting is null then
    raise exception 'meeting_question_gate: the meeting must be named' using errcode = '22023';
  end if;

  select q.taken into v_taken
    from public.meeting_question_days q
   where q.day = (now() at time zone 'utc')::date
     and q.meeting_id = p_meeting;

  return coalesce(v_taken, 0) >= p_limit;
end
$$;

comment on function public.meeting_question_gate(integer, uuid) is
  'Reads whether a meeting is over its daily count of questions. Writes nothing (ADR-0020).';

-- Take one of today's questions on this meeting, if any are left. One statement decides it, as
-- in take_demo_question: concurrent callers queue on the row, and Postgres checks the WHERE
-- again against the row each one finally sees, so a limit of N grants exactly N.
create or replace function public.take_meeting_question(
  p_limit   integer,
  p_meeting uuid
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_day date := (clock_timestamp() at time zone 'utc')::date;
begin
  if p_limit is null then
    raise exception 'take_meeting_question: the limit must be given' using errcode = '22023';
  end if;
  if p_meeting is null then
    raise exception 'take_meeting_question: the meeting must be named' using errcode = '22023';
  end if;
  if p_limit <= 0 then
    return false;
  end if;

  delete from public.meeting_question_days where day < v_day;

  insert into public.meeting_question_days as q (day, meeting_id, taken)
  values (v_day, p_meeting, 1)
  on conflict (day, meeting_id) do update
    set taken = q.taken + 1
    where q.taken < p_limit;

  return found;
end
$$;

comment on function public.take_meeting_question(integer, uuid) is
  'Counts one question on a meeting today if the limit allows, and answers whether it did. Deletes earlier days (ADR-0020).';

-- As for the demo's: only the service role reaches these, guarded for a plain Postgres.
do $$
begin
  revoke all on function public.meeting_question_gate(integer, uuid) from public;
  revoke all on function public.take_meeting_question(integer, uuid) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.meeting_question_gate(integer, uuid) from anon;
    revoke all on function public.take_meeting_question(integer, uuid) from anon;
    revoke all on table public.meeting_question_days from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.meeting_question_gate(integer, uuid) from authenticated;
    revoke all on function public.take_meeting_question(integer, uuid) from authenticated;
    revoke all on table public.meeting_question_days from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.meeting_question_gate(integer, uuid) to service_role;
    grant execute on function public.take_meeting_question(integer, uuid) to service_role;
    grant select, insert, update, delete on table public.meeting_question_days to service_role;
  end if;
end $$;
