-- 'failed' used to mean one thing. Once summarisation could also fail it meant
-- two, and nothing recorded which: the transcription retry route and the
-- progress UI both treated ANY 'failed' meeting as a transcription failure,
-- so retrying a summarisation failure re-ran transcription and overwrote a
-- perfectly good transcript. This column disambiguates. Apply with
-- `supabase db push` or the SQL editor.

-- The column comment below says failed_stage is null outside `failed`. Every
-- write in the app actually keeps that (both retry routes clear it the
-- instant they take a meeting out of `failed`, and set it the instant they
-- put one in), so it is enforced here rather than only promised in prose —
-- a future write that violates it now fails loudly instead of leaving a
-- stage that no longer describes the current error.
alter table public.meetings
  add column if not exists failed_stage text
  check (
    (failed_stage in ('transcription', 'summarization') or failed_stage is null)
    and (status = 'failed') = (failed_stage is not null)
  );

comment on column public.meetings.failed_stage is
  'Which stage produced the current error_message when status is failed. Null outside failed.';
