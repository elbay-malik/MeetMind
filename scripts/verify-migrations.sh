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
# pgvector's image, not stock Postgres: transcript_windows has a vector column,
# and the stock image has no `vector` type to create it with.
IMAGE=pgvector/pgvector:pg17

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "starting ${IMAGE} ..."
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg -p "$PORT:5432" "$IMAGE" >/dev/null

# Everything talks TCP (-h localhost), never the unix socket, and that is the
# whole readiness fix — see the loop below. TCP needs a password where the
# local socket is trusted, hence PGPASSWORD.
psql() { docker exec -i -e PGPASSWORD=pg "$CONTAINER" \
  psql -U postgres -h localhost -v ON_ERROR_STOP=1 "$@"; }

# Wait for a query to succeed OVER TCP, not for `pg_isready` and not for a
# query over the unix socket.
#
# The postgres image starts a temporary server so it can run initdb and any
# init scripts, then shuts it down and starts the real one. `pg_isready`
# reports ready during that first window, so a loop that breaks on it can
# proceed into the shutdown and die with "connection to server on socket
# .s.PGSQL.5432 failed: No such file or directory".
#
# Waiting on a real `select 1` was the first attempt at a fix and is NOT
# enough: the temporary server answers queries perfectly well, so the loop
# still breaks early and the same error comes back intermittently. What
# actually separates the two is that the temporary server is started with
# `listen_addresses=''` and so is reachable only over the unix socket. A query
# over TCP therefore cannot succeed until the real server is up. This is the
# same discriminator the official docker-entrypoint uses internally.
ready=0
for _ in $(seq 1 60); do
  if psql -q -c 'select 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "FAIL: Postgres never accepted a query in 60s"; docker logs "$CONTAINER" | tail -20; exit 1; }

# Applied separately, below: it needs a legacy row inserted right before it to
# prove its backfill actually runs against data that predates the column.
FAILED_STAGE_MIGRATION=supabase/migrations/20260913120000_add_meeting_failed_stage.sql

insert_legacy_failed_rows() {
  # Meetings that failed before failed_stage existed have failed_stage=NULL.
  # The migration's new CHECK validates every existing row the instant it is
  # added, so without a backfill these inserts would make the ALTER TABLE
  # itself fail against a real, populated database — not caught by inserting
  # the rows only after the migration, which is what every other check in this
  # file does. Two rows: meeting_summaries/summarize.post.ts shipped with Phase
  # 6 before this column did, so a pre-existing failed row is only safely
  # assumed to be a transcription failure when it has no transcript at all —
  # one that already has segments could just as easily be a real summarisation
  # failure, and the backfill needs to tell those apart correctly.
  psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
              values (gen_random_uuid(),'legacy failure, no transcript','failed','a.mp4',1,'legacy_failed_no_transcript',10);"
  psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
              values (gen_random_uuid(),'legacy failure, has transcript','failed','a.mp4',1,'legacy_failed_has_transcript',10);"
  psql -q -c "insert into public.transcript_segments (meeting_id, idx, start_ms, end_ms, text)
              select id, 0, 0, 1000, 'hello' from public.meetings where audio_key='legacy_failed_has_transcript';"
}

# In timestamp order, exactly as production applies them. The failed_stage
# migration used to be skipped here and applied LAST, so any later migration
# would have been verified in an order production never uses.
[ -f "$FAILED_STAGE_MIGRATION" ] || { echo "FAIL: $FAILED_STAGE_MIGRATION is missing"; exit 1; }
for f in supabase/migrations/*.sql; do
  [ "$f" = "$FAILED_STAGE_MIGRATION" ] && insert_legacy_failed_rows
  echo "applying $(basename "$f")"
  psql -q < "$f"
done

fail() { echo "FAIL: $1"; exit 1; }
check() { # check <description> <sql returning t/f>
  local got
  got=$(psql -At -c "$2")
  [ "$got" = "t" ] || fail "$1 (got '$got')"
  echo "  ok: $1"
}

echo "checking schema invariants ..."

# Read from the constant itself. The old check never opened the TypeScript at
# all, and matched the constraint text with LIKE '%25000000%' — a cap of
# 250000000 contains that substring and passed a check labelled "matches".
CAP=$(grep -E "^export const MAX_AUDIO_BYTES = " shared/utils/meeting.ts | sed -E 's/.*= *([0-9_]+).*/\1/' | tr -d _)
[[ "$CAP" =~ ^[0-9]+$ ]] || fail "MAX_AUDIO_BYTES did not parse as a plain integer (got '$CAP')"
[ -n "$CAP" ] || fail "could not read MAX_AUDIO_BYTES from shared/utils/meeting.ts"
echo "  (MAX_AUDIO_BYTES in shared/utils/meeting.ts: ${CAP})"
psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
            values (gen_random_uuid(),'x','uploaded','a.mp4',1,'at_cap',${CAP});"
check "audio_bytes exactly at MAX_AUDIO_BYTES is accepted" \
  "select count(*)=1 from public.meetings where audio_key='at_cap'"
psql -q -c "delete from public.meetings where audio_key='at_cap';"

check "row-level security is on with no policies" \
  "select relrowsecurity and (select count(*) from pg_policies where tablename='meetings')=0
   from pg_class where relname='meetings'"

# Every status in the TypeScript union must be insertable. `failed` also needs
# a failed_stage, now that the column requires one exactly when status='failed'.
# Read from the union itself: a status added in code but not in SQL used to
# pass, because this list was a copy.
STATUSES=$(sed -n '/^export type MeetingStatus/,/^$/p' shared/types/meeting.ts | grep -o "'[a-z_]*'" | tr '\n' ',' | sed 's/,$//')
[ -n "$STATUSES" ] || fail "could not read MeetingStatus from shared/types/meeting.ts"
STATUS_COUNT=$(echo "$STATUSES" | tr ',' '\n' | grep -c .)
echo "  (MeetingStatus values in shared/types/meeting.ts: ${STATUSES})"
psql -q -c "do \$\$
declare s text;
begin
  foreach s in array array[${STATUSES}] loop
    insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes,failed_stage)
    values (gen_random_uuid(), s, s, 'a.mp4', 1, 'lifecycle_'||s, 10, case when s = 'failed' then 'transcription' end);
  end loop;
end \$\$;"
check "every MeetingStatus value is accepted" \
  "select count(*)=${STATUS_COUNT} from public.meetings where audio_key like 'lifecycle_%'"

# Rejections.
reject() { # reject <description> <sql> <expected error fragment>
  local out
  out=$(docker exec -i -e PGPASSWORD=pg "$CONTAINER" \
    psql -U postgres -h localhost -c "$2" 2>&1 || true)
  echo "$out" | grep -q "$3" || fail "$1 — expected '$3', got: $out"
  echo "  ok: $1"
}
reject "audio_bytes one over MAX_AUDIO_BYTES is refused" \
  "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes) values (gen_random_uuid(),'x','uploaded','a.mp4',1,'over',$((CAP + 1)));" \
  "violates check constraint \"meetings_audio_bytes_check\""
reject "an unknown status is refused" \
  "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes) values (gen_random_uuid(),'x','nope','a.mp4',1,'badstatus',10);" \
  "violates check"

psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
            values (gen_random_uuid(),'x','uploaded','a.mp4',1,'stage_null',10);"
psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes,failed_stage)
            values (gen_random_uuid(),'x','failed','a.mp4',1,'stage_transcription',10,'transcription');"
psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes,failed_stage)
            values (gen_random_uuid(),'x','failed','a.mp4',1,'stage_summarization',10,'summarization');"
psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes,failed_stage)
            values (gen_random_uuid(),'x','failed','a.mp4',1,'stage_upload',10,'upload');"
# Every stage the TypeScript union declares, read from the type itself rather
# than hard-coded here: a stage added in code and forgotten in the migration
# otherwise passes this file while failing against the real database.
STAGES=$(grep -E "^  failedStage:" shared/types/meeting.ts \
  | grep -o "'[a-z]*'" | tr -d "'" | tr '\n' ' ')
# Loudly, not silently: an extraction that quietly matches nothing would turn
# this whole block into a no-op that still prints nothing and passes.
[ -n "${STAGES// /}" ] || fail "could not read failedStage's declared values from shared/types/meeting.ts"
echo "  (failed_stage values declared in shared/types/meeting.ts: ${STAGES})"
for stage in $STAGES; do
  psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes,failed_stage)
              values (gen_random_uuid(),'x','failed','a.mp4',1,'stage_decl_${stage}',10,'${stage}')
              on conflict do nothing;" >/dev/null
  check "failed_stage accepts '${stage}', which shared/types/meeting.ts declares" \
    "select failed_stage = '${stage}' from public.meetings where audio_key = 'stage_decl_${stage}'"
done
check "failed_stage accepts null outside failed" \
  "select failed_stage is null from public.meetings where audio_key='stage_null'"
check "a legacy failed row with no transcript is backfilled to transcription" \
  "select failed_stage = 'transcription' from public.meetings where audio_key = 'legacy_failed_no_transcript'"
check "a legacy failed row that already has a transcript is backfilled to summarization, not transcription" \
  "select failed_stage = 'summarization' from public.meetings where audio_key = 'legacy_failed_has_transcript'"
# Both legacy rows have served their purpose; clean up so later checks that
# assume an otherwise-empty transcript_segments table still hold.
psql -q -c "delete from public.meetings
            where audio_key in ('legacy_failed_no_transcript', 'legacy_failed_has_transcript');"
reject "failed_stage outside the declared stages is refused" \
  "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes,failed_stage)
   values (gen_random_uuid(),'x','failed','a.mp4',1,'stage_bad',10,'indexing');" \
  "violates check constraint \"meetings_failed_stage_matches_status\""
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
  "select array_agg(att.attname::text order by k.ord) = array['meeting_id','idx']
   from pg_constraint con
   cross join unnest(con.conkey) with ordinality as k(attnum, ord)
   join pg_attribute att on att.attrelid=con.conrelid and att.attnum = k.attnum
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

# Per table. The old aggregate used bool_and over whichever of the three
# tables happened to exist, so with only meeting_summaries created it
# returned true for a check naming all three.
for t in meeting_summaries meeting_decisions meeting_action_items; do
  check "$t exists, has row-level security on, and has no policies" \
    "select exists (select 1 from pg_class where oid = to_regclass('public.$t') and relrowsecurity)
       and (select count(*) from pg_policies where schemaname='public' and tablename='$t') = 0"
done

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

# --- transcript_windows (ADR-0007) ------------------------------------------
# Vectors are built from arrays in SQL: a unit vector along axis N is 767 zeros
# and a single 1 at position N, which makes nearest-first ordering exact to
# reason about.
unit_vector() { # unit_vector <1-based axis>
  echo "(select array_agg(case when i = $1 then 1 else 0 end order by i)::real[]::extensions.vector from generate_series(1,768) i)"
}
HASH_A=$(printf 'a%.0s' $(seq 1 64))
HASH_B=$(printf 'b%.0s' $(seq 1 64))

check "transcript_windows exists, has row-level security on, and has no policies" \
  "select exists (select 1 from pg_class where oid = to_regclass('public.transcript_windows') and relrowsecurity)
     and (select count(*) from pg_policies where schemaname='public' and tablename='transcript_windows') = 0"

check "transcript_windows.embedding is a 768-dimension vector" \
  "select format_type(atttypid, atttypmod) = 'extensions.vector(768)'
   from pg_attribute where attrelid='public.transcript_windows'::regclass and attname='embedding'"

check "a transcript window is keyed by (meeting_id, idx), in that order" \
  "select array_agg(att.attname::text order by k.ord) = array['meeting_id','idx']
   from pg_constraint con
   cross join unnest(con.conkey) with ordinality as k(attnum, ord)
   join pg_attribute att on att.attrelid=con.conrelid and att.attnum = k.attnum
   where con.conrelid='public.transcript_windows'::regclass and con.contype='p'"

psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
            values ('33333333-3333-3333-3333-333333333333','w','ready','a.mp4',1,'windows_a',10),
                   ('44444444-4444-4444-4444-444444444444','w','ready','a.mp4',1,'windows_b',10);"
insert_window() { # insert_window <meeting uuid> <idx> <axis> <model> <hash>
  psql -q -c "insert into public.transcript_windows
      (meeting_id, idx, first_segment_idx, last_segment_idx, start_ms, end_ms, content, content_hash, model, embedding)
    values ('$1', $2, $2, $2 + 1, $2 * 1000, $2 * 1000 + 999, 'window $2', '$5', '$4', $(unit_vector "$3"));"
}
# Meeting A: windows along axes 1, 2 and 3, one of them from a different model.
insert_window 33333333-3333-3333-3333-333333333333 0 1 gemini-embedding-2 "$HASH_A"
insert_window 33333333-3333-3333-3333-333333333333 1 2 gemini-embedding-2 "$HASH_A"
insert_window 33333333-3333-3333-3333-333333333333 2 3 some-other-model "$HASH_A"
# Meeting B holds the single best match for the query — it must never leak into A's results.
insert_window 44444444-4444-4444-4444-444444444444 0 2 gemini-embedding-2 "$HASH_B"

# A query leaning towards axis 2, then axis 1.
QUERY="(select array_agg(case when i = 2 then 0.9 when i = 1 then 0.4 else 0 end order by i)::real[]::extensions.vector from generate_series(1,768) i)"
check "match_transcript_windows returns the nearest window first, within one meeting" \
  "select array_agg(idx order by ord) = array[1, 0]
   from public.match_transcript_windows('33333333-3333-3333-3333-333333333333', $QUERY, 'gemini-embedding-2', 5)
        with ordinality as m(idx, a, b, c, d, e, f, g, ord)"
check "match_transcript_windows never returns another meeting's windows" \
  "select not exists (select 1
     from public.match_transcript_windows('33333333-3333-3333-3333-333333333333', $QUERY, 'gemini-embedding-2', 5) m
     where m.content_hash = '$HASH_B')"
check "match_transcript_windows ignores windows embedded by a different model" \
  "select not exists (select 1
     from public.match_transcript_windows('33333333-3333-3333-3333-333333333333', $QUERY, 'gemini-embedding-2', 5) m
     where m.idx = 2)"
check "match_transcript_windows reports cosine similarity (1 for an identical vector)" \
  "select abs(similarity - 1) < 1e-6
   from public.match_transcript_windows('33333333-3333-3333-3333-333333333333', $(unit_vector 1), 'gemini-embedding-2', 1)"
check "match_transcript_windows clamps a zero or negative limit up to one row" \
  "select (select count(*) from public.match_transcript_windows('33333333-3333-3333-3333-333333333333', $QUERY, 'gemini-embedding-2', 0)) = 1
      and (select count(*) from public.match_transcript_windows('33333333-3333-3333-3333-333333333333', $QUERY, 'gemini-embedding-2', -5)) = 1"
check "match_transcript_windows pins its search_path" \
  "select exists (select 1 from pg_proc
     where proname = 'match_transcript_windows'
       and proconfig @> array['search_path=public, extensions'])"

reject "a window with a vector of the wrong dimension is refused" \
  "insert into public.transcript_windows
     (meeting_id, idx, first_segment_idx, last_segment_idx, start_ms, end_ms, content, content_hash, model, embedding)
   values ('33333333-3333-3333-3333-333333333333', 9, 0, 1, 0, 1, 'x', '$HASH_A', 'gemini-embedding-2',
           array_fill(0.1::real, array[767])::extensions.vector);" \
  "expected 768 dimensions, not 767"
reject "a window whose content hash is not SHA-256 hex is refused" \
  "insert into public.transcript_windows
     (meeting_id, idx, first_segment_idx, last_segment_idx, start_ms, end_ms, content, content_hash, model, embedding)
   values ('33333333-3333-3333-3333-333333333333', 9, 0, 1, 0, 1, 'x', 'not-a-hash', 'gemini-embedding-2', $(unit_vector 1));" \
  "violates check constraint \"transcript_windows_content_hash_check\""
reject "a window whose range ends before it starts is refused" \
  "insert into public.transcript_windows
     (meeting_id, idx, first_segment_idx, last_segment_idx, start_ms, end_ms, content, content_hash, model, embedding)
   values ('33333333-3333-3333-3333-333333333333', 9, 5, 4, 0, 1, 'x', '$HASH_A', 'gemini-embedding-2', $(unit_vector 1));" \
  "violates check constraint \"transcript_windows_check\""


psql -q -c "delete from public.meetings where audio_key='windows_a';"
check "deleting a meeting removes its windows, and only its windows" \
  "select (select count(*) from public.transcript_windows
           where meeting_id='33333333-3333-3333-3333-333333333333') = 0
      and (select count(*) from public.transcript_windows
           where meeting_id='44444444-4444-4444-4444-444444444444') = 1"
psql -q -c "delete from public.meetings where audio_key='windows_b';"

# --- match_transcript_windows_across_meetings (ADR-0008) --------------------
# Meeting Y holds the query's dominant axis exactly (best possible match) plus
# a second, weaker window, to check the per-meeting cap. Meeting X holds a
# weaker real match AND a wrong-model window at the query's BEST axis — if the
# wrong-model window counted, X would incorrectly outrank Y. Meeting Z is
# orthogonal to the query entirely, to check the meeting cap excludes it once
# two better meetings exist.
psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
            values ('55555555-5555-5555-5555-555555555555','y','ready','a.mp4',1,'windows_y',10),
                   ('66666666-6666-6666-6666-666666666666','x','ready','a.mp4',1,'windows_x',10),
                   ('77777777-7777-7777-7777-777777777777','z','ready','a.mp4',1,'windows_z',10);"
insert_window 55555555-5555-5555-5555-555555555555 0 2 gemini-embedding-2 "$HASH_A"
insert_window 55555555-5555-5555-5555-555555555555 1 1 gemini-embedding-2 "$HASH_A"
insert_window 66666666-6666-6666-6666-666666666666 0 1 gemini-embedding-2 "$HASH_A"
insert_window 66666666-6666-6666-6666-666666666666 1 2 some-other-model "$HASH_A"
insert_window 77777777-7777-7777-7777-777777777777 0 6 gemini-embedding-2 "$HASH_A"

check "match_transcript_windows_across_meetings ranks meetings by their own best match, meeting Y first" \
  "select array_agg(meeting_id order by first_ord) = array['55555555-5555-5555-5555-555555555555'::uuid, '66666666-6666-6666-6666-666666666666'::uuid]
   from (
     select meeting_id, min(ord) as first_ord
     from public.match_transcript_windows_across_meetings($QUERY, 'gemini-embedding-2', 2, 5)
          with ordinality as m(meeting_id, idx, first_segment_idx, last_segment_idx, start_ms, end_ms, content, content_hash, similarity, ord)
     group by meeting_id
   ) ranked"
check "match_transcript_windows_across_meetings tags every row with the meeting it actually belongs to" \
  "select bool_and(
     (meeting_id = '55555555-5555-5555-5555-555555555555' and idx in (0,1))
     or (meeting_id = '66666666-6666-6666-6666-666666666666' and idx = 0))
   from public.match_transcript_windows_across_meetings($QUERY, 'gemini-embedding-2', 3, 5)
   where meeting_id in ('55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666')"
check "match_transcript_windows_across_meetings ignores a window embedded by a different model, even at the best axis" \
  "select not exists (select 1
     from public.match_transcript_windows_across_meetings($QUERY, 'gemini-embedding-2', 5, 5) m
     where m.meeting_id = '66666666-6666-6666-6666-666666666666' and m.idx = 1)"
check "match_transcript_windows_across_meetings caps how many meetings are returned" \
  "select count(distinct meeting_id) = 2
   from public.match_transcript_windows_across_meetings($QUERY, 'gemini-embedding-2', 2, 5) m
   where m.meeting_id in ('55555555-5555-5555-5555-555555555555','66666666-6666-6666-6666-666666666666','77777777-7777-7777-7777-777777777777')"
check "match_transcript_windows_across_meetings caps how many windows one meeting contributes" \
  "select count(*) = 1
   from public.match_transcript_windows_across_meetings($QUERY, 'gemini-embedding-2', 5, 1) m
   where m.meeting_id = '55555555-5555-5555-5555-555555555555'"
check "match_transcript_windows_across_meetings clamps a zero or negative meeting limit up to one meeting" \
  "select (select count(distinct meeting_id) from public.match_transcript_windows_across_meetings($QUERY, 'gemini-embedding-2', 0, 5)) = 1
      and (select count(distinct meeting_id) from public.match_transcript_windows_across_meetings($QUERY, 'gemini-embedding-2', -5, 5)) = 1"
check "match_transcript_windows_across_meetings clamps a zero or negative per-meeting limit up to one row" \
  "select (select count(*) from public.match_transcript_windows_across_meetings($QUERY, 'gemini-embedding-2', 1, 0)) = 1
      and (select count(*) from public.match_transcript_windows_across_meetings($QUERY, 'gemini-embedding-2', 1, -5)) = 1"
check "match_transcript_windows_across_meetings pins its search_path" \
  "select exists (select 1 from pg_proc
     where proname = 'match_transcript_windows_across_meetings'
       and proconfig @> array['search_path=public, extensions'])"

psql -q -c "delete from public.meetings where audio_key in ('windows_y','windows_x','windows_z');"

# Grouping under a TIE. Nothing else in this file creates one, which is how the
# defect this catches survived: two meetings with identical content embed
# identically and tie exactly on best_distance, and the local driver groups by
# construction (it sorts per-meeting arrays and flattens), so only real
# Postgres could ever show the rows interleaving.
psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
            values ('88888888-8888-8888-8888-888888888888','dup a','ready','a.mp4',1,'windows_dup_a',10),
                   ('99999999-9999-9999-9999-999999999999','dup b','ready','a.mp4',1,'windows_dup_b',10);"
insert_window 88888888-8888-8888-8888-888888888888 0 2 gemini-embedding-2 "$HASH_A"
insert_window 88888888-8888-8888-8888-888888888888 1 1 gemini-embedding-2 "$HASH_A"
insert_window 99999999-9999-9999-9999-999999999999 0 2 gemini-embedding-2 "$HASH_A"
insert_window 99999999-9999-9999-9999-999999999999 1 1 gemini-embedding-2 "$HASH_A"
# Counts contiguous blocks: a row starts a new block when its meeting differs
# from the row before it. Grouped => exactly 2 blocks for 2 meetings;
# interleaved (a,b,a,b) => 4.
check "match_transcript_windows_across_meetings keeps each meeting's rows contiguous when two meetings tie" \
  "select count(*) filter (where meeting_id is distinct from prev) = 2
   from (
     select meeting_id, lag(meeting_id) over (order by ord) as prev
     from public.match_transcript_windows_across_meetings($QUERY, 'gemini-embedding-2', 5, 5)
          with ordinality as m(meeting_id, idx, first_segment_idx, last_segment_idx, start_ms, end_ms, content, content_hash, similarity, ord)
   ) ordered"
psql -q -c "delete from public.meetings where audio_key in ('windows_dup_a','windows_dup_b');"


# updated_at must advance on update. now() is transaction-scoped, so the insert
# and the update have to happen in separate transactions or this always passes.
psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
            values ('22222222-2222-2222-2222-222222222222','t','pending_upload','a.mp4',1,'trigger_probe',10);"
psql -q -c "update public.meetings set updated_at='2000-01-01' where id='22222222-2222-2222-2222-222222222222';"
check "updated_at trigger overrides whatever the client sends" \
  "select updated_at > created_at from public.meetings where id='22222222-2222-2222-2222-222222222222'"
psql -q -c "delete from public.meetings where audio_key='trigger_probe';"


# stored_audio_bytes aggregates the WHOLE table, so unlike every check above it
# cannot be scoped to its own rows by an audio_key filter. The earlier checks
# leave rows behind, and those bytes would be counted here. They have all
# asserted what they needed by now, so clear the table first -- without this the
# expected totals below are off by whatever happens to remain, which is exactly
# how this first failed.
psql -q -c "delete from public.meetings;"

# stored_audio_bytes is the whole storage budget, so each clause of its WHERE
# gets its own row here. Every case below is a reason an object is or is not in
# the bucket while its row stays behind, and getting any of them backwards makes
# the budget either useless or permanently closed.
psql -q -c "insert into public.meetings
              (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes,uploaded_at,failed_stage)
            values
              -- counted: a confirmed upload inside the retention window
              (gen_random_uuid(),'t','uploaded','a.mp4',1,'sab_fresh',1000,now()-interval '1 day',null),
              -- counted: failed, but not at the upload stage, so the object is still there
              (gen_random_uuid(),'t','failed','a.mp4',1,'sab_failed_later',2000,now()-interval '1 day','transcription'),
              -- NOT counted: the upload was rejected and failMeetingUpload deleted the object
              (gen_random_uuid(),'t','failed','a.mp4',1,'sab_rejected',4000,now()-interval '1 day','upload'),
              -- NOT counted: expired by the bucket lifecycle rule
              (gen_random_uuid(),'t','uploaded','a.mp4',1,'sab_expired',8000,now()-interval '90 days',null);"
# counted: registered moments ago, so its presigned PUT can still land
psql -q -c "insert into public.meetings
              (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
            values (gen_random_uuid(),'t','pending_upload','a.mp4',1,'sab_reserved',16000);"
# NOT counted: registered long ago, so its upload URL has expired and cannot land
psql -q -c "insert into public.meetings
              (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes,created_at)
            values (gen_random_uuid(),'t','pending_upload','a.mp4',1,'sab_abandoned',32000,now()-interval '1 day');"

check "stored_audio_bytes counts a fresh upload and a non-upload failure, and reserves a live registration" \
  "select public.stored_audio_bytes(30, 900) = 1000 + 2000 + 16000"
# Asserted as "the row is present AND its bytes are absent from the total".
# `<> 23000` would have passed for any wrong answer at all, which is the way a
# check like this quietly stops testing anything.
check "stored_audio_bytes excludes a rejected upload, whose object was deleted" \
  "select exists (select 1 from public.meetings where audio_key = 'sab_rejected')
          and public.stored_audio_bytes(30, 900) = 1000 + 2000 + 16000"
check "stored_audio_bytes excludes an upload the lifecycle rule has expired" \
  "select public.stored_audio_bytes(30, 900) < public.stored_audio_bytes(0, 900)"
check "stored_audio_bytes with no retention rule counts every surviving upload" \
  "select public.stored_audio_bytes(0, 900) = 1000 + 2000 + 8000 + 16000"
check "stored_audio_bytes stops reserving a registration whose upload URL has expired" \
  "select public.stored_audio_bytes(30, 86400 * 2) = 1000 + 2000 + 16000 + 32000"
check "stored_audio_bytes is zero, not null, when nothing is stored" \
  "select public.stored_audio_bytes(30, 0) = 1000 + 2000"
check "stored_audio_bytes pins its search_path" \
  "select 'search_path=public' = any(proconfig) from pg_proc where proname = 'stored_audio_bytes'"
psql -q -c "delete from public.meetings where audio_key like 'sab_%';"
check "stored_audio_bytes returns 0 rather than null for an empty table" \
  "select public.stored_audio_bytes(30, 900) = 0"


# reserve_slot / note_rate_limit pace provider calls across every server
# instance (ADR-0012). Each case mirrors one in tests/unit/slots.spec.ts, which
# asserts the same rule against the local driver's reserveFrom.
#
# Every call runs as its OWN statement, its result kept in vm_r, and the checks
# read state afterwards. A check that called the function and read
# provider_slots in one statement would read the statement's starting snapshot,
# never see the call's own writes, and pass "nothing changed" vacuously.
psql -q -c "create table vm_r (label text primary key, granted boolean, slot_at timestamptz, taken_at timestamptz default clock_timestamp());"
reserve() { # reserve <label> <provider> <interval_ms> <max_wait_ms>
  psql -q -c "insert into vm_r (label, granted, slot_at) select '$1', granted, slot_at from public.reserve_slot('$2', $3, $4);"
}
next_at() { echo "(select next_available_at from public.provider_slots where provider = '$1')"; }
r() { echo "(select $2 from vm_r where label = '$1')"; }

check "provider_slots has RLS on and no policies" \
  "select c.relrowsecurity and not exists (select 1 from pg_policy where polrelid = c.oid)
   from pg_class c where c.oid = 'public.provider_slots'::regclass"

reserve first vm_a 60000 0
check "reserve_slot grants a free provider now" \
  "select $(r first granted) and $(r first slot_at) between $(r first taken_at) - interval '5 seconds' and $(r first taken_at)"
check "reserve_slot moves the next slot one interval past the grant" \
  "select $(next_at vm_a) - $(r first slot_at) = interval '60 seconds'"

reserve refused vm_a 60000 0
check "reserve_slot refuses when the next slot is past the caller's wait, and says when it frees" \
  "select not $(r refused granted) and $(r refused slot_at) = $(r first slot_at) + interval '60 seconds'"
check "reserve_slot reserves NOTHING for a caller it refuses" \
  "select $(next_at vm_a) = $(r first slot_at) + interval '60 seconds'"

reserve waited vm_a 60000 120000
check "reserve_slot places a waiting caller at the next slot, not now" \
  "select $(r waited granted) and $(r waited slot_at) = $(r first slot_at) + interval '60 seconds'"
check "and moves the next slot past that one" \
  "select $(next_at vm_a) = $(r first slot_at) + interval '120 seconds'"

psql -q -At -c "select public.note_rate_limit('vm_b', 90000);" >/dev/null
reserve blocked vm_b 0 0
check "reserve_slot places no slot before a provider's Retry-After" \
  "select not $(r blocked granted) and $(r blocked slot_at) > $(r blocked taken_at) + interval '80 seconds'"
reserve blockedwait vm_b 0 120000
check "reserve_slot grants a waiting caller no earlier than the Retry-After" \
  "select $(r blockedwait granted) and $(r blockedwait slot_at) > $(r blockedwait taken_at) + interval '80 seconds'"
psql -q -At -c "select public.note_rate_limit('vm_b', 5000);" >/dev/null
check "note_rate_limit never shortens a block" \
  "select (select blocked_until from public.provider_slots where provider = 'vm_b') > clock_timestamp() + interval '80 seconds'"

reject "reserve_slot refuses a negative interval rather than moving the next slot backwards" \
  "select * from public.reserve_slot('vm_c', -1, 0)" "must be non-negative"
reject "reserve_slot refuses a NULL wait rather than writing a NULL slot" \
  "select * from public.reserve_slot('vm_c', 1000, null)" "must be non-negative"
check "reserve_slot and note_rate_limit pin their search_path" \
  "select bool_and('search_path=public' = any(proconfig)) and count(*) = 2
   from pg_proc where proname in ('reserve_slot', 'note_rate_limit')"
psql -q -c "drop table vm_r; delete from public.provider_slots where provider like 'vm_%';"

echo
echo "RESULT: PASS — $(ls supabase/migrations/*.sql | wc -l | tr -d ' ') migrations applied, all invariants hold"
