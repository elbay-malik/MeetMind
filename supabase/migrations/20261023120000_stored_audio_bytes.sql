-- How many bytes of audio the bucket is actually holding.
--
-- R2 has no spending cap: past the free allowance Cloudflare bills rather than
-- refusing, and the one usage notification needs a Professional plan. Storage is
-- the recurring charge -- $0.015 per GB-month, every month, for as long as the
-- object exists -- and nothing in the app bounded it. `POST /api/meetings` is
-- anonymous and there is no DELETE route anywhere in the API, so an abuse script
-- could grow a standing monthly bill with no in-app way to reverse it.
--
-- Computed from the rows rather than kept in a counter. A counter drifts: the
-- bucket's lifecycle rule deletes objects without telling the database, and a
-- crash between the write and the increment loses a byte count permanently. The
-- aggregate below is self-correcting because it is derived, and it is only read
-- when a meeting is registered, which is rare.
create or replace function public.stored_audio_bytes(
  p_retention_days      integer,
  p_reservation_seconds integer
)
returns bigint
language sql
stable
set search_path = public
as $$
  select coalesce(sum(m.audio_bytes), 0)::bigint
  from public.meetings m
  where
    -- Registered but not yet confirmed. The presigned PUT is still live, so
    -- these bytes can land at any moment and have to be reserved -- otherwise a
    -- burst of registrations all pass the check and then all upload. Past the
    -- URL's lifetime they cannot land, so an abandoned registration stops
    -- counting instead of inflating the total for ever.
    (
      m.status = 'pending_upload'
      and m.created_at > now() - make_interval(secs => p_reservation_seconds)
    )
    or
    -- Confirmed uploads, less the two ways an object leaves the bucket while its
    -- row stays behind:
    --   * a rejected upload, whose object failMeetingUpload deleted. The
    --     status/failed_stage pair here is exactly `uploadWasRejected` in
    --     shared/utils/meeting.ts; the two must agree.
    --   * expiry by the bucket's own lifecycle rule, p_retention_days after
    --     the upload. p_retention_days <= 0 means no such rule, so nothing
    --     expires and every confirmed upload counts.
    (
      m.status <> 'pending_upload'
      and not (m.status = 'failed' and m.failed_stage = 'upload')
      and m.uploaded_at is not null
      and (
        p_retention_days <= 0
        or m.uploaded_at > now() - make_interval(days => p_retention_days)
      )
    )
$$;

comment on function public.stored_audio_bytes(integer, integer) is
  'Bytes of audio the object store is expected to be holding: confirmed uploads whose objects have neither been deleted nor expired, plus registrations whose presigned PUT is still live. Read by the storage budget that gates POST /api/meetings.';

-- Same posture as the other functions here: the browser roles have no reason to
-- call this, and RLS would return them nothing anyway. Guarded, because a plain
-- Postgres has none of these roles.
do $$
begin
  revoke all on function public.stored_audio_bytes(integer, integer) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.stored_audio_bytes(integer, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.stored_audio_bytes(integer, integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.stored_audio_bytes(integer, integer) to service_role;
  end if;
end $$;
