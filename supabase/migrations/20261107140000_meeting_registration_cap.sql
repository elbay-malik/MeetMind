-- A daily ceiling on new meetings across the whole app (ADR-0020). Every meeting can go on to
-- spend transcription, extraction and indexing quota and stored bytes, and registering one takes
-- only the shared invite code, so new meetings have a ceiling per UTC day and the free quotas stay
-- available. Only the service role reaches any of this, and only after the invite code passed.
--
-- 1. meeting_registration_days holds one count per UTC day. Taking one deletes earlier days, so
--    the table never holds more than a day or two.
-- 2. take_meeting_registration counts one, before the upload URL is issued. There is no gate
--    before it as there is for questions: no slot comes between, so reading first would only add
--    a call.
--
-- Safe to run again: everything is conditional or replaces itself, and a count is kept.

create table if not exists public.meeting_registration_days (
  day   date primary key,
  taken integer not null default 0 check (taken >= 0)
);

comment on table public.meeting_registration_days is
  'New meetings registered, by UTC day. Earlier days are deleted by the next take (ADR-0020).';

alter table public.meeting_registration_days enable row level security;

-- Take one of today's registrations, if any are left. One statement decides it, as in
-- take_demo_question: concurrent callers queue on the row, and Postgres checks the WHERE again
-- against the row each one finally sees, so a limit of N grants exactly N.
create or replace function public.take_meeting_registration(
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
    raise exception 'take_meeting_registration: the limit must be given' using errcode = '22023';
  end if;
  if p_limit <= 0 then
    return false;
  end if;

  delete from public.meeting_registration_days where day < v_day;

  insert into public.meeting_registration_days as r (day, taken)
  values (v_day, 1)
  on conflict (day) do update
    set taken = r.taken + 1
    where r.taken < p_limit;

  return found;
end
$$;

comment on function public.take_meeting_registration(integer) is
  'Counts one new meeting today if the limit allows, and answers whether it did. Deletes earlier days (ADR-0020).';

-- As for the question counts: only the service role reaches these, guarded for a plain Postgres.
do $$
begin
  revoke all on function public.take_meeting_registration(integer) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.take_meeting_registration(integer) from anon;
    revoke all on table public.meeting_registration_days from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.take_meeting_registration(integer) from authenticated;
    revoke all on table public.meeting_registration_days from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.take_meeting_registration(integer) to service_role;
    grant select, insert, update, delete on table public.meeting_registration_days to service_role;
  end if;
end $$;
