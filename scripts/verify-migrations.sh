#!/usr/bin/env bash
# Applies supabase/migrations/*.sql to a throwaway Postgres and asserts the
# schema invariants the app relies on. Supabase is never reachable from this
# machine, so this is the only place the SQL actually runs before deploy.
#
# Usage: scripts/verify-migrations.sh     (requires Docker; uses port 55432)
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER=meetmind-migration-check
PORT=55432
IMAGE=postgres:17-alpine

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "starting ${IMAGE} ..."
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg -p "$PORT:5432" "$IMAGE" >/dev/null
for _ in $(seq 1 40); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 2
done

psql() { docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 "$@"; }

# Applied separately, below: it needs a legacy row inserted right before it to
# prove its backfill actually runs against data that predates the column.
FAILED_STAGE_MIGRATION=supabase/migrations/20260913120000_add_meeting_failed_stage.sql
for f in supabase/migrations/*.sql; do
  [ "$f" = "$FAILED_STAGE_MIGRATION" ] && continue
  echo "applying $(basename "$f")"
  psql -q < "$f"
done

# A meeting that failed before failed_stage existed has failed_stage=NULL.
# The migration's new CHECK validates every existing row the instant it is
# added, so without a backfill this insert would make the ALTER TABLE itself
# fail against a real, populated database — not caught by inserting the row
# only after the migration, which is what every other check in this file does.
psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
            values (gen_random_uuid(),'legacy failure','failed','a.mp4',1,'legacy_failed_row',10);"
echo "applying $(basename "$FAILED_STAGE_MIGRATION")"
psql -q < "$FAILED_STAGE_MIGRATION"

fail() { echo "FAIL: $1"; exit 1; }
check() { # check <description> <sql returning t/f>
  local got
  got=$(psql -At -c "$2")
  [ "$got" = "t" ] || fail "$1 (got '$got')"
  echo "  ok: $1"
}

echo "checking schema invariants ..."

check "audio cap matches MAX_AUDIO_BYTES in shared/utils/meeting.ts" \
  "select pg_get_constraintdef(con.oid) like '%25000000%'
   from pg_constraint con join pg_class rel on rel.oid=con.conrelid
   where rel.relname='meetings' and con.contype='c'
     and pg_get_constraintdef(con.oid) like '%audio_bytes%'"

check "row-level security is on with no policies" \
  "select relrowsecurity and (select count(*) from pg_policies where tablename='meetings')=0
   from pg_class where relname='meetings'"

# Every status in the TypeScript union must be insertable. `failed` also needs
# a failed_stage, now that the column requires one exactly when status='failed'.
psql -q -c "do \$\$
declare s text;
begin
  foreach s in array array['pending_upload','uploaded','transcribing','summarizing','indexing','ready','failed'] loop
    insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes,failed_stage)
    values (gen_random_uuid(), s, s, 'a.mp4', 1, 'lifecycle_'||s, 10, case when s = 'failed' then 'transcription' end);
  end loop;
end \$\$;"
check "every MeetingStatus value is accepted" \
  "select count(*)=7 from public.meetings where audio_key like 'lifecycle_%'"

# Rejections.
reject() { # reject <description> <sql> <expected error fragment>
  local out
  out=$(docker exec -i "$CONTAINER" psql -U postgres -c "$2" 2>&1 || true)
  echo "$out" | grep -q "$3" || fail "$1 — expected '$3', got: $out"
  echo "  ok: $1"
}
reject "audio_bytes above the cap is refused" \
  "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes) values (gen_random_uuid(),'x','uploaded','a.mp4',1,'over',25000001);" \
  "violates check"
reject "an unknown status is refused" \
  "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes) values (gen_random_uuid(),'x','nope','a.mp4',1,'badstatus',10);" \
  "violates check"

psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
            values (gen_random_uuid(),'x','uploaded','a.mp4',1,'stage_null',10);"
psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes,failed_stage)
            values (gen_random_uuid(),'x','failed','a.mp4',1,'stage_transcription',10,'transcription');"
psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes,failed_stage)
            values (gen_random_uuid(),'x','failed','a.mp4',1,'stage_summarization',10,'summarization');"
check "failed_stage accepts null and both real stages" \
  "select bool_and(ok) from (
     select failed_stage is null as ok from public.meetings where audio_key='stage_null'
     union all select failed_stage='transcription' from public.meetings where audio_key='stage_transcription'
     union all select failed_stage='summarization' from public.meetings where audio_key='stage_summarization'
   ) t"
check "a failed row from before failed_stage existed is backfilled, not rejected" \
  "select failed_stage = 'transcription' from public.meetings where audio_key = 'legacy_failed_row'"
reject "failed_stage outside the two real stages is refused" \
  "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes,failed_stage)
   values (gen_random_uuid(),'x','failed','a.mp4',1,'stage_bad',10,'indexing');" \
  "violates check"
reject "a non-failed meeting cannot carry a failed_stage" \
  "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes,failed_stage)
   values (gen_random_uuid(),'x','ready','a.mp4',1,'stage_mismatch_a',10,'transcription');" \
  "violates check"
reject "a failed meeting must carry a failed_stage" \
  "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
   values (gen_random_uuid(),'x','failed','a.mp4',1,'stage_mismatch_b',10);" \
  "violates check"
reject "a duplicate audio_key is refused" \
  "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes) values (gen_random_uuid(),'x','uploaded','a.mp4',1,'lifecycle_ready',10);" \
  "duplicate key"

check "transcript_segments cascades from meetings" \
  "select confdeltype='c' from pg_constraint
   where conrelid='public.transcript_segments'::regclass and contype='f'"

check "a transcript segment is keyed by (meeting_id, idx)" \
  "select array_agg(att.attname::text order by att.attname) = array['idx','meeting_id']
   from pg_constraint con
   join pg_attribute att on att.attrelid=con.conrelid and att.attnum = any(con.conkey)
   where con.conrelid='public.transcript_segments'::regclass and con.contype='p'"

check "transcript_segments has row-level security on with no policies" \
  "select relrowsecurity and (select count(*) from pg_policies where tablename='transcript_segments')=0
   from pg_class where relname='transcript_segments'"

# Segments must survive a re-run and vanish with their meeting.
psql -q -c "insert into public.transcript_segments (meeting_id, idx, start_ms, end_ms, text)
            select id, 0, 0, 1000, 'hello' from public.meetings where audio_key='lifecycle_ready';"
reject "a segment ending before it starts is refused" \
  "insert into public.transcript_segments (meeting_id, idx, start_ms, end_ms, text)
   select id, 1, 5000, 4000, 'backwards' from public.meetings where audio_key='lifecycle_ready';" \
  "violates check"
reject "a duplicate (meeting_id, idx) is refused" \
  "insert into public.transcript_segments (meeting_id, idx, start_ms, end_ms, text)
   select id, 0, 0, 1, 'dup' from public.meetings where audio_key='lifecycle_ready';" \
  "duplicate key"
psql -q -c "delete from public.meetings where audio_key='lifecycle_ready';"
check "deleting a meeting removes its transcript" \
  "select count(*)=0 from public.transcript_segments"

for t in meeting_decisions meeting_action_items; do
  # A 2-column FK to transcript_segments is not enough on its own: it could be
  # shaped from the wrong source columns onto the wrong two columns of the
  # target and still match a check that only counts columns and tables.
  # Compare the actual source and referenced column names, in order, instead.
  check "$t's citation FK is (meeting_id, segment_idx) -> transcript_segments(meeting_id, idx)" \
    "select exists (
       select 1 from pg_constraint con
       where con.conrelid='public.$t'::regclass and con.contype='f'
         and con.confrelid='public.transcript_segments'::regclass
         and pg_get_constraintdef(con.oid) ilike '%on delete cascade%'
         and (
           select array_agg(att.attname::text order by k.ord)
           from unnest(con.conkey) with ordinality as k(attnum, ord)
           join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
         ) = array['meeting_id', 'segment_idx']
         and (
           select array_agg(att.attname::text order by k.ord)
           from unnest(con.confkey) with ordinality as k(attnum, ord)
           join pg_attribute att on att.attrelid = con.confrelid and att.attnum = k.attnum
         ) = array['meeting_id', 'idx']
     )"
done

check "summaries, decisions and action items all have RLS on with no policies" \
  "select bool_and(c.relrowsecurity)
     and (select count(*) from pg_policies
          where tablename in ('meeting_summaries','meeting_decisions','meeting_action_items'))=0
   from pg_class c where c.relname in
     ('meeting_summaries','meeting_decisions','meeting_action_items')"

# Extraction rows must hang off a real segment and vanish with the meeting.
psql -q -c "insert into public.transcript_segments (meeting_id, idx, start_ms, end_ms, text)
            select id, 0, 0, 1000, 'we agreed to ship' from public.meetings where audio_key='lifecycle_summarizing';"
psql -q -c "insert into public.meeting_summaries (meeting_id, summary, provider)
            select id, 'a summary', 'stub' from public.meetings where audio_key='lifecycle_summarizing';"
psql -q -c "insert into public.meeting_decisions (meeting_id, idx, decision, quote, segment_idx, start_ms)
            select id, 0, 'ship it', 'we agreed to ship', 0, 0 from public.meetings where audio_key='lifecycle_summarizing';"
psql -q -c "insert into public.meeting_action_items (meeting_id, idx, task, quote, segment_idx, start_ms)
            select id, 0, 'ship it', 'we agreed to ship', 0, 0 from public.meetings where audio_key='lifecycle_summarizing';"
check "a decision citing a real segment is accepted" \
  "select count(*)=1 from public.meeting_decisions"
check "an action item citing a real segment is accepted" \
  "select count(*)=1 from public.meeting_action_items"

reject "a decision citing a segment that does not exist is refused" \
  "insert into public.meeting_decisions (meeting_id, idx, decision, quote, segment_idx, start_ms)
   select id, 1, 'invented', 'nobody said this', 99, 0 from public.meetings where audio_key='lifecycle_summarizing';" \
  "violates foreign key"

reject "an action item citing a segment that does not exist is refused" \
  "insert into public.meeting_action_items (meeting_id, idx, task, quote, segment_idx, start_ms)
   select id, 1, 'invented', 'nobody said this', 99, 0 from public.meetings where audio_key='lifecycle_summarizing';" \
  "violates foreign key"

reject "an unknown provider is refused" \
  "insert into public.meeting_summaries (meeting_id, summary, provider)
   select id, 's', 'guesswork' from public.meetings where audio_key='lifecycle_pending_upload';" \
  "violates check"

# Re-transcription shape: replaceForMeeting deletes and re-inserts segments for
# the SAME meeting, without touching the meeting row itself. The migration's
# own header comment claims this cannot leave items citing a segment that is
# gone — assert that directly rather than only proving cascade-on-meeting-delete.
psql -q -c "delete from public.transcript_segments
            where meeting_id=(select id from public.meetings where audio_key='lifecycle_summarizing')
              and idx=0;"
check "re-transcription cascades a stale citation away without deleting the summary" \
  "select (select count(*) from public.meeting_decisions
           where meeting_id=(select id from public.meetings where audio_key='lifecycle_summarizing'))=0
      and (select count(*) from public.meeting_action_items
           where meeting_id=(select id from public.meetings where audio_key='lifecycle_summarizing'))=0
      and exists (select 1 from public.meeting_summaries
                  where meeting_id=(select id from public.meetings where audio_key='lifecycle_summarizing'))"

psql -q -c "delete from public.meetings where audio_key='lifecycle_summarizing';"
check "deleting a meeting removes its summary, decisions and action items" \
  "select (select count(*) from public.meeting_summaries)=0
      and (select count(*) from public.meeting_decisions)=0
      and (select count(*) from public.meeting_action_items)=0"

# updated_at must advance on update. now() is transaction-scoped, so the insert
# and the update have to happen in separate transactions or this always passes.
psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
            values ('22222222-2222-2222-2222-222222222222','t','pending_upload','a.mp4',1,'trigger_probe',10);"
psql -q -c "update public.meetings set updated_at='2000-01-01' where id='22222222-2222-2222-2222-222222222222';"
check "updated_at trigger overrides whatever the client sends" \
  "select updated_at > created_at from public.meetings where id='22222222-2222-2222-2222-222222222222'"

echo
echo "RESULT: PASS — $(ls supabase/migrations/*.sql | wc -l | tr -d ' ') migrations applied, all invariants hold"
