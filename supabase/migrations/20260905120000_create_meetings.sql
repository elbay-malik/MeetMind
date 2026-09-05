-- Meetings: one row per uploaded recording. Only the compressed audio's
-- storage key is recorded here — the original video never reaches the server.
-- Apply with `supabase db push` (Supabase CLI) or paste into the SQL editor.

create table if not exists public.meetings (
  id               uuid primary key,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  title            text not null check (char_length(title) between 1 and 200),
  status           text not null check (status in (
                     'pending_upload', 'uploaded', 'transcribing',
                     'summarizing', 'indexing', 'ready', 'failed')),
  source_file_name text not null check (char_length(source_file_name) between 1 and 255),
  source_bytes     bigint not null check (source_bytes >= 0),
  source_mime      text,
  duration_sec     double precision check (duration_sec > 0),
  audio_key        text not null unique,
  -- 25 MiB: Groq Whisper's free-tier upload cap, enforced again in code.
  audio_bytes      integer not null check (audio_bytes > 0 and audio_bytes <= 26214400),
  audio_mime       text not null default 'audio/ogg',
  uploaded_at      timestamptz,
  error_message    text
);

comment on table public.meetings is
  'Meeting recordings: metadata plus the storage key of the browser-compressed audio. No video is ever stored.';

create index if not exists meetings_created_at_idx on public.meetings (created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists meetings_set_updated_at on public.meetings;
create trigger meetings_set_updated_at
  before update on public.meetings
  for each row execute function public.set_updated_at();

-- Locked down: RLS on, no policies. Only the server's service-role client
-- (which bypasses RLS) can read or write; anon/authenticated keys see nothing.
alter table public.meetings enable row level security;
