-- The optional retention purge (ADR-0017): which meeting the cron sweeper would delete next.
-- It deletes nothing itself: the sweeper takes the answer through the same delete as the admin
-- route, with its blocker and its fence. Off until NUXT_RETENTION_PURGE_DAYS is set.
--
-- Age comes from created_at, which only the database writes, against the database's own clock.
-- `meetings_created_at_idx` serves the oldest first, so this reads a row or two.
--
-- Safe to run again: it replaces itself, and touches no row.
create or replace function public.next_expired_meeting(
  p_days    integer,
  p_exclude uuid
)
returns uuid
language plpgsql
stable
set search_path = public
as $$
begin
  -- Neither has a safe reading. No age would make every meeting expired, and a null
  -- would compare as nothing to leave out, which is the public demo gone for good.
  if p_days is null or p_days <= 0 then
    raise exception 'next_expired_meeting: the days must be a positive whole number, got %', p_days using errcode = '22023';
  end if;
  if p_exclude is null then
    raise exception 'next_expired_meeting: the public demo must be named' using errcode = '22023';
  end if;

  return (
    select m.id
      from public.meetings m
     where m.created_at < clock_timestamp() - make_interval(days => p_days)
       and m.id <> p_exclude
       and not exists (select 1 from public.pipeline_runs r
                        where r.meeting_id = m.id and r.step_lease_until > clock_timestamp())
     order by m.created_at
     limit 1
  );
end
$$;

comment on function public.next_expired_meeting(integer, uuid) is
  'The oldest meeting past the retention days with no live step, never the demo, or null. Deletes nothing (ADR-0017).';

-- A new function starts with EXECUTE for PUBLIC, and on Supabase for its API roles.
-- Only the service role reaches this. Guarded, because a plain Postgres has none of
-- these roles.
do $$
begin
  revoke all on function public.next_expired_meeting(integer, uuid) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.next_expired_meeting(integer, uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.next_expired_meeting(integer, uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.next_expired_meeting(integer, uuid) to service_role;
  end if;
end $$;
