-- Embedded windows of a meeting's transcript, for semantic Q&A (ADR-0007).
-- Apply with `supabase db push` or the SQL editor.
--
-- A window is a run of consecutive transcript segments embedded as one
-- retrieval unit. Windows reference their segments by RANGE, which a foreign key
-- cannot express, so a replaced transcript does not cascade them away. Instead
-- every row carries a hash of its text and range: indexing re-embeds any window
-- whose hash no longer matches the transcript, and answering treats a retrieved
-- window with a stale hash as "re-index first", never as current text.

-- Supabase installs extensions into `extensions`; created here too so the same
-- migration applies to a plain Postgres with pgvector (verify-migrations.sh).
create schema if not exists extensions;
create extension if not exists vector with schema extensions;

create table if not exists public.transcript_windows (
  meeting_id        uuid not null references public.meetings (id) on delete cascade,
  idx               integer not null check (idx >= 0),
  first_segment_idx integer not null check (first_segment_idx >= 0),
  last_segment_idx  integer not null,
  start_ms          integer not null check (start_ms >= 0),
  end_ms            integer not null,
  content           text not null check (length(content) > 0),
  -- SHA-256 hex over the text and the range: what makes the index resumable
  -- and a replaced transcript detectable.
  content_hash      text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  -- Vectors from different models are not comparable, so every row names its
  -- model and search filters on it. The column's dimension is fixed: a model
  -- with a different size needs a migration.
  model             text not null check (length(model) > 0),
  embedding         extensions.vector(768) not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (meeting_id, idx),
  check (last_segment_idx >= first_segment_idx),
  check (end_ms >= start_ms)
);

comment on table public.transcript_windows is
  'Embedded runs of consecutive transcript segments. content_hash detects windows made stale by a replaced transcript; model keeps vectors from different models apart.';

drop trigger if exists transcript_windows_set_updated_at on public.transcript_windows;
create trigger transcript_windows_set_updated_at
  before update on public.transcript_windows
  for each row execute function public.set_updated_at();

-- Same posture as every other table: only the service role reaches these.
alter table public.transcript_windows enable row level security;

-- Nearest windows to a question within ONE meeting, by cosine similarity.
--
-- An exact scan, deliberately — no HNSW index yet (ADR-0007 decision 4). A
-- meeting holds on the order of a hundred windows, so ordering them all by
-- distance is cheap and returns exactly the nearest ones. An HNSW index under a
-- selective meeting filter can return fewer rows than asked for unless
-- iterative scans are configured; that trade only pays off for cross-meeting
-- search, which is Phase 8.
--
-- The limit is clamped: a caller cannot ask for zero rows, or for a result set
-- large enough to blow the answering model's token budget.
create or replace function public.match_transcript_windows(
  p_meeting_id  uuid,
  p_query       extensions.vector(768),
  p_model       text,
  p_match_count integer
)
returns table (
  idx               integer,
  first_segment_idx integer,
  last_segment_idx  integer,
  start_ms          integer,
  end_ms            integer,
  content           text,
  content_hash      text,
  similarity        double precision
)
language sql
stable
-- Pinned, so the operator resolves to pgvector's and not to whatever an
-- earlier schema on the caller's search_path defines.
set search_path = public, extensions
as $$
  select w.idx, w.first_segment_idx, w.last_segment_idx, w.start_ms, w.end_ms,
         w.content, w.content_hash,
         1 - (w.embedding <=> p_query) as similarity
  from public.transcript_windows w
  where w.meeting_id = p_meeting_id
    and w.model = p_model
  order by w.embedding <=> p_query, w.idx
  limit least(greatest(coalesce(p_match_count, 1), 1), 20);
$$;

-- Supabase grants EXECUTE on new public functions to its API roles by default.
-- Row-level security already returns nothing to them, but there is no reason
-- for a browser role to be able to call this at all. Guarded, because a plain
-- Postgres has none of these roles.
do $$
begin
  revoke all on function public.match_transcript_windows(uuid, extensions.vector, text, integer) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.match_transcript_windows(uuid, extensions.vector, text, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.match_transcript_windows(uuid, extensions.vector, text, integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.match_transcript_windows(uuid, extensions.vector, text, integer) to service_role;
  end if;
end $$;
