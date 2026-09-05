-- Transcript segments: one row per timestamped chunk of speech returned by the
-- speech-to-text model. Apply with `supabase db push` or the SQL editor.
--
-- Times are integer MILLISECONDS, not float seconds. Whisper returns float
-- seconds, but milliseconds compare exactly in tests, seek exactly in the
-- player, and avoid float drift when segments are offset or merged.

create table if not exists public.transcript_segments (
  meeting_id  uuid not null references public.meetings (id) on delete cascade,
  -- Position within the transcript, gapless from 0. Part of the primary key so
  -- re-running transcription replaces rows instead of duplicating them.
  idx         integer not null check (idx >= 0),
  start_ms    integer not null check (start_ms >= 0),
  end_ms      integer not null check (end_ms >= 0),
  text        text not null,
  created_at  timestamptz not null default now(),
  primary key (meeting_id, idx),
  constraint transcript_segments_span_check check (end_ms >= start_ms)
);

comment on table public.transcript_segments is
  'Timestamped transcript segments for a meeting. Times are integer milliseconds from the start of the audio.';

-- The player and the transcript view always read a whole meeting in order.
create index if not exists transcript_segments_meeting_start_idx
  on public.transcript_segments (meeting_id, start_ms);

-- Same posture as meetings: only the service role reaches this table.
alter table public.transcript_segments enable row level security;
