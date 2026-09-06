-- Structured extraction from a meeting transcript: one summary per meeting,
-- plus the decisions and action items it contains. Apply with `supabase db push`
-- or the SQL editor.
--
-- Every decision and action item carries the transcript segment that evidences
-- it. The foreign key is composite so a citation cannot point at a segment that
-- does not exist, and cascades so re-transcribing a meeting cannot leave items
-- citing segments that are gone.

create table if not exists public.meeting_summaries (
  -- One row per meeting, so re-running extraction is an upsert on the key.
  meeting_id  uuid primary key references public.meetings (id) on delete cascade,
  summary     text not null,
  provider    text not null check (provider in ('groq', 'stub')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.meeting_summaries is
  'One structured summary per meeting. provider records whether a real model or the local stub produced it.';

create table if not exists public.meeting_decisions (
  meeting_id  uuid not null references public.meetings (id) on delete cascade,
  idx         integer not null check (idx >= 0),
  decision    text not null,
  -- The transcript words that evidence this, verified against the transcript
  -- before the row is written.
  quote       text not null,
  segment_idx integer not null check (segment_idx >= 0),
  start_ms    integer not null check (start_ms >= 0),
  created_at  timestamptz not null default now(),
  primary key (meeting_id, idx),
  foreign key (meeting_id, segment_idx)
    references public.transcript_segments (meeting_id, idx) on delete cascade
);

comment on table public.meeting_decisions is
  'Decisions extracted from a meeting, each citing the transcript segment that supports it.';

create table if not exists public.meeting_action_items (
  meeting_id    uuid not null references public.meetings (id) on delete cascade,
  idx           integer not null check (idx >= 0),
  task          text not null,
  -- Null means nobody was named. A model forced to supply a name invents one,
  -- so the absence has to be representable.
  assignee      text,
  -- The due date as spoken, unresolved: we have no meeting date or timezone to
  -- resolve "next Friday" against.
  due_date_text text,
  quote         text not null,
  segment_idx   integer not null check (segment_idx >= 0),
  start_ms      integer not null check (start_ms >= 0),
  created_at    timestamptz not null default now(),
  primary key (meeting_id, idx),
  foreign key (meeting_id, segment_idx)
    references public.transcript_segments (meeting_id, idx) on delete cascade
);

comment on table public.meeting_action_items is
  'Action items extracted from a meeting. assignee and due_date_text are null when the meeting did not say.';

create index if not exists meeting_decisions_start_idx
  on public.meeting_decisions (meeting_id, start_ms);
create index if not exists meeting_action_items_start_idx
  on public.meeting_action_items (meeting_id, start_ms);

drop trigger if exists meeting_summaries_set_updated_at on public.meeting_summaries;
create trigger meeting_summaries_set_updated_at
  before update on public.meeting_summaries
  for each row execute function public.set_updated_at();

-- Same posture as every other table: only the service role reaches these.
alter table public.meeting_summaries enable row level security;
alter table public.meeting_decisions enable row level security;
alter table public.meeting_action_items enable row level security;
