-- 'failed' used to mean one thing. Once summarisation could also fail it meant
-- two, and nothing recorded which: the transcription retry route and the
-- progress UI both treated ANY 'failed' meeting as a transcription failure,
-- so retrying a summarisation failure re-ran transcription and overwrote a
-- perfectly good transcript. This column disambiguates. Apply with
-- `supabase db push` or the SQL editor.

alter table public.meetings
  add column if not exists failed_stage text
  check (failed_stage in ('transcription', 'summarization') or failed_stage is null);

comment on column public.meetings.failed_stage is
  'Which stage produced the current error_message when status is failed. Null outside failed.';
