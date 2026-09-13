-- 'failed' used to mean one thing. Once summarisation could also fail it meant
-- two, and nothing recorded which: the transcription retry route and the
-- progress UI both treated ANY 'failed' meeting as a transcription failure,
-- so retrying a summarisation failure re-ran transcription and overwrote a
-- perfectly good transcript. This column disambiguates. Apply with
-- `supabase db push` or the SQL editor.

alter table public.meetings
  add column if not exists failed_stage text;

-- Backfill existing rows before the status-aware check below can be attached:
-- adding a CHECK validates every existing row immediately, and any meeting
-- already sitting at status='failed' from before this column existed would
-- otherwise have failed_stage=NULL and fail that check outright.
--
-- Blanket-assigning 'transcription' would be wrong in the common case:
-- meeting_summaries and summarize.post.ts shipped with Phase 6, before this
-- column, so a failed row from that window can already be a genuine
-- summarisation failure. Whether transcript_segments exist for the meeting is
-- the best signal available for telling the two apart after the fact, since
-- summarize.post.ts only ever runs once they do, and (at the time this
-- migration was written) nothing re-transcribes an already-transcribed
-- meeting.
--
-- That signal is not perfectly reliable, and this is a genuine, accepted
-- limitation rather than a solved one: before failedStage existed, EVERY
-- 'failed' meeting was treated as a transcription failure by the retry route,
-- including one that was really a summarisation failure -- so a client could
-- "retry" a summarisation failure through the transcription route, have that
-- retry itself fail before ever reaching transcripts.replaceForMeeting, and
-- leave a row that is failed_stage='transcription' by the actual sequence of
-- events but still has the OLD segments from before any of this happened.
-- This backfill has no way to distinguish that historical row from an
-- ordinary summarisation failure -- the information that would tell them
-- apart (which failure happened most recently) was never recorded. Given the
-- choice between two imperfect guesses, this is the less costly one to get
-- wrong: a misclassified 'summarization' row retries through
-- summarize.post.ts, which extracts from whatever transcript is already
-- there (usable, if possibly not the newest); a misclassified 'transcription'
-- row would instead retry through transcribe.post.ts and unconditionally
-- replace that transcript, which is the more destructive mistake to default
-- to at scale.
update public.meetings m
  set failed_stage = case
    when exists (select 1 from public.transcript_segments s where s.meeting_id = m.id)
      then 'summarization'
    else 'transcription'
  end
  where m.status = 'failed' and m.failed_stage is null;

-- The column comment below says failed_stage is null outside `failed`. Every
-- write in the app actually keeps that (both retry routes clear it the
-- instant they take a meeting out of `failed`, and set it the instant they
-- put one in), so it is enforced here rather than only promised in prose —
-- a future write that violates it now fails loudly instead of leaving a
-- stage that no longer describes the current error. In a `do` block, since
-- `alter table ... add constraint if not exists` is not valid Postgres syntax.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'meetings_failed_stage_matches_status'
  ) then
    alter table public.meetings
      add constraint meetings_failed_stage_matches_status
      check (
        (failed_stage in ('transcription', 'summarization') or failed_stage is null)
        and (status = 'failed') = (failed_stage is not null)
      );
  end if;
end $$;

comment on column public.meetings.failed_stage is
  'Which stage produced the current error_message when status is failed. Null outside failed.';
