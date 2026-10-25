-- One request slot per interval per provider, shared by every server instance.
--
-- Groq's limits are per ACCOUNT (8,000 tokens a minute for the extraction
-- model), and the app paced its requests with an in-memory queue. On Workers
-- every isolate has its own memory and many run at once, so that queue paced
-- nothing: two isolates each started empty and could both fire in the same
-- minute (ADR-0012). The slot has to live somewhere every instance shares, and
-- Postgres is the one such place already in the stack.
create table public.provider_slots (
  provider          text primary key,
  -- When the next request may start. Advanced by one interval per grant.
  next_available_at timestamptz not null default now(),
  -- The provider said "not before then" (a 429's Retry-After). No grant is
  -- placed before it, whatever the interval says.
  blocked_until     timestamptz not null default now()
);

-- Only the server's service role reaches this table, and it bypasses RLS.
alter table public.provider_slots enable row level security;

-- Reserve the next request slot for a provider, if it starts within
-- p_max_wait_ms of now. Granted: returns (true, when to send) and moves the
-- provider's next slot one interval past it. Not granted: returns (false, when
-- the next slot frees) and reserves NOTHING, so a caller that gives up holds no
-- slot that would delay everyone after it.
--
-- One UPDATE decides it. Concurrent callers queue on the row lock, and Postgres
-- re-evaluates the WHERE against the row each one finally sees, so N callers
-- get N distinct slots one interval apart -- never two in the same slot.
-- clock_timestamp(), not now(): now() is fixed when the transaction starts, and
-- a caller that waited on the lock would otherwise compute its slot from a
-- moment that has already passed.
create or replace function public.reserve_slot(
  p_provider    text,
  p_interval_ms integer,
  p_max_wait_ms integer
)
returns table (granted boolean, slot_at timestamptz)
language plpgsql
set search_path = public
as $$
declare
  v_slot timestamptz;
begin
  -- A NULL interval would write a NULL slot and break every later call; a
  -- negative one would move the next slot backwards. Refused, loudly.
  if p_interval_ms is null or p_interval_ms < 0 or p_max_wait_ms is null or p_max_wait_ms < 0 then
    raise exception 'reserve_slot: interval and wait must be non-negative, got % and %', p_interval_ms, p_max_wait_ms
      using errcode = '22023';
  end if;

  insert into public.provider_slots (provider) values (p_provider)
  on conflict (provider) do nothing;

  update public.provider_slots s
     set next_available_at = greatest(clock_timestamp(), s.next_available_at, s.blocked_until)
                             + make_interval(secs => p_interval_ms / 1000.0)
   where s.provider = p_provider
     and greatest(clock_timestamp(), s.next_available_at, s.blocked_until)
         <= clock_timestamp() + make_interval(secs => p_max_wait_ms / 1000.0)
  returning s.next_available_at - make_interval(secs => p_interval_ms / 1000.0) into v_slot;

  if found then
    return query select true, v_slot;
  else
    return query
      select false, greatest(clock_timestamp(), s.next_available_at, s.blocked_until)
      from public.provider_slots s
      where s.provider = p_provider;
  end if;
end
$$;

comment on function public.reserve_slot(text, integer, integer) is
  'Reserve the next request slot for a provider if it starts within p_max_wait_ms; otherwise report when it frees and reserve nothing. Paces provider calls across every server instance (ADR-0012).';

-- The provider refused with a 429 and said how long to wait. Never shortens an
-- existing block: two refusals with different Retry-After values both hold.
create or replace function public.note_rate_limit(
  p_provider       text,
  p_retry_after_ms integer
)
returns void
language sql
set search_path = public
as $$
  insert into public.provider_slots (provider, blocked_until)
  values (p_provider, clock_timestamp() + make_interval(secs => p_retry_after_ms / 1000.0))
  on conflict (provider) do update
    set blocked_until = greatest(public.provider_slots.blocked_until, excluded.blocked_until)
$$;

comment on function public.note_rate_limit(text, integer) is
  'Record a provider''s 429 Retry-After so every server instance waits it out (ADR-0012).';

-- Same posture as the other functions: the browser roles have no reason to call
-- these. Guarded, because a plain Postgres has none of these roles.
do $$
declare
  fn text;
begin
  foreach fn in array array['public.reserve_slot(text, integer, integer)', 'public.note_rate_limit(text, integer)'] loop
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
