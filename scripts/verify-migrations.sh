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
TMPDIR_SWEEP=$(mktemp -d)
# pgvector's image, not stock Postgres: transcript_windows has a vector column,
# and the stock image has no `vector` type to create it with.
IMAGE=pgvector/pgvector:pg17

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$TMPDIR_SWEEP"; }
trap cleanup EXIT
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

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

# Applied with a stored window and indexes on the old column in place, to prove it
# clears what a cast could not convert rather than only working on an empty table.
EMBEDDING_MIGRATION=supabase/migrations/20261102120000_workers_ai_embeddings.sql

prepare_legacy_windows() {
  # Supabase has these roles and a plain Postgres does not, so without them the
  # migration's revokes and its grant to service_role never run here.
  psql -q -c "create role anon nologin; create role authenticated nologin; create role service_role nologin;"
  # Supabase hands every new function to its API roles by default privileges. Without
  # this the migration's revokes from those two have nothing to take away, and
  # removing them would still pass here. Not service_role, so its grant is tested too.
  psql -q -c "alter default privileges in schema public grant execute on functions to anon, authenticated;"
  psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
              values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','legacy window','ready','a.mp4',1,'legacy_window',10);"
  psql -q -c "insert into public.transcript_windows
      (meeting_id, idx, first_segment_idx, last_segment_idx, start_ms, end_ms, content, content_hash, model, embedding)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 0, 0, 1, 0, 999, 'old window', '$(printf 'c%.0s' $(seq 1 64))', 'an-old-768-model',
            array_fill(0.1::real, array[768])::extensions.vector);"
  psql -q -c "create index legacy_embedding_hnsw on public.transcript_windows
                using hnsw (embedding extensions.vector_cosine_ops);
              create index legacy_embedding_expression on public.transcript_windows ((extensions.vector_norm(embedding)));"
}

# In timestamp order, exactly as production applies them. The failed_stage
# migration used to be skipped here and applied LAST, so any later migration
# would have been verified in an order production never uses.
[ -f "$FAILED_STAGE_MIGRATION" ] || { echo "FAIL: $FAILED_STAGE_MIGRATION is missing"; exit 1; }
[ -f "$EMBEDDING_MIGRATION" ] || { echo "FAIL: $EMBEDDING_MIGRATION is missing"; exit 1; }
for f in supabase/migrations/*.sql; do
  [ "$f" = "$FAILED_STAGE_MIGRATION" ] && insert_legacy_failed_rows
  [ "$f" = "$EMBEDDING_MIGRATION" ] && prepare_legacy_windows
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
# Read from the constant itself, like MAX_AUDIO_BYTES above: the column and the
# code have to agree, and a copy of the number here would agree with neither.
DIMENSIONS=$(grep -E "^export const EMBEDDING_DIMENSIONS = " server/utils/qa/embedder.ts | sed -E 's/.*= *([0-9_]+).*/\1/' | tr -d _)
[[ "$DIMENSIONS" =~ ^[0-9]+$ ]] || fail "EMBEDDING_DIMENSIONS did not parse as a plain integer (got '$DIMENSIONS')"
echo "  (EMBEDDING_DIMENSIONS in server/utils/qa/embedder.ts: ${DIMENSIONS})"

# Vectors are built from arrays in SQL: a unit vector along axis N is all zeros
# but for a single 1 at position N, which makes nearest-first ordering exact to
# reason about.
unit_vector() { # unit_vector <1-based axis>
  echo "(select array_agg(case when i = $1 then 1 else 0 end order by i)::real[]::extensions.vector from generate_series(1,$DIMENSIONS) i)"
}
HASH_A=$(printf 'a%.0s' $(seq 1 64))
HASH_B=$(printf 'b%.0s' $(seq 1 64))

check "transcript_windows exists, has row-level security on, and has no policies" \
  "select exists (select 1 from pg_class where oid = to_regclass('public.transcript_windows') and relrowsecurity)
     and (select count(*) from pg_policies where schemaname='public' and tablename='transcript_windows') = 0"

check "transcript_windows.embedding has the size the code produces" \
  "select format_type(atttypid, atttypmod) = 'extensions.vector($DIMENSIONS)'
   from pg_attribute where attrelid='public.transcript_windows'::regclass and attname='embedding'"

# --- the move to 1024 dimensions (ADR-0014) ---------------------------------
LEGACY_MEETING=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
check "the window stored at the old size is gone, and its meeting is not" \
  "select (select count(*) from public.transcript_windows where meeting_id='$LEGACY_MEETING') = 0
      and (select count(*) from public.meetings where id='$LEGACY_MEETING') = 1"
check "no index on the old column is left, hand-built or over an expression" \
  "select not exists (
     select 1 from pg_depend d
     join pg_class c on c.oid = d.objid and c.relkind = 'i'
     join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
     where d.refobjid = 'public.transcript_windows'::regclass and a.attname = 'embedding')"
check "the primary key survived the indexes being dropped" \
  "select exists (select 1 from pg_constraint
     where conrelid='public.transcript_windows'::regclass and contype='p')"
check "match_transcript_windows_across_meetings is gone" \
  "select not exists (select 1 from pg_proc where proname = 'match_transcript_windows_across_meetings')"
check "match_transcript_windows exists exactly once" \
  "select count(*) = 1 from pg_proc where proname = 'match_transcript_windows'"
MATCH_FN='public.match_transcript_windows(uuid, extensions.vector, text, integer)'
check_match_privileges() {
  check "$1" \
    "select not has_function_privilege('anon', '$MATCH_FN', 'execute')
        and not has_function_privilege('authenticated', '$MATCH_FN', 'execute')
        and not exists (select 1 from aclexplode((select proacl from pg_proc where proname = 'match_transcript_windows')) a where a.grantee = 0)
        and has_function_privilege('service_role', '$MATCH_FN', 'execute')"
}
check_match_privileges "match_transcript_windows is executable by the service role and not by anon, authenticated or PUBLIC"

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
insert_window 33333333-3333-3333-3333-333333333333 0 1 @cf/baai/bge-m3 "$HASH_A"
insert_window 33333333-3333-3333-3333-333333333333 1 2 @cf/baai/bge-m3 "$HASH_A"
insert_window 33333333-3333-3333-3333-333333333333 2 3 some-other-model "$HASH_A"
# Meeting B holds the single best match for the query — it must never leak into A's results.
insert_window 44444444-4444-4444-4444-444444444444 0 2 @cf/baai/bge-m3 "$HASH_B"

# A query leaning towards axis 2, then axis 1.
QUERY="(select array_agg(case when i = 2 then 0.9 when i = 1 then 0.4 else 0 end order by i)::real[]::extensions.vector from generate_series(1,$DIMENSIONS) i)"
check "match_transcript_windows returns the nearest window first, within one meeting" \
  "select array_agg(idx order by ord) = array[1, 0]
   from public.match_transcript_windows('33333333-3333-3333-3333-333333333333', $QUERY, '@cf/baai/bge-m3', 5)
        with ordinality as m(idx, a, b, c, d, e, f, g, ord)"
check "match_transcript_windows never returns another meeting's windows" \
  "select not exists (select 1
     from public.match_transcript_windows('33333333-3333-3333-3333-333333333333', $QUERY, '@cf/baai/bge-m3', 5) m
     where m.content_hash = '$HASH_B')"
check "match_transcript_windows ignores windows embedded by a different model" \
  "select not exists (select 1
     from public.match_transcript_windows('33333333-3333-3333-3333-333333333333', $QUERY, '@cf/baai/bge-m3', 5) m
     where m.idx = 2)"
check "match_transcript_windows reports cosine similarity (1 for an identical vector)" \
  "select abs(similarity - 1) < 1e-6
   from public.match_transcript_windows('33333333-3333-3333-3333-333333333333', $(unit_vector 1), '@cf/baai/bge-m3', 1)"
check "match_transcript_windows clamps a zero or negative limit up to one row" \
  "select (select count(*) from public.match_transcript_windows('33333333-3333-3333-3333-333333333333', $QUERY, '@cf/baai/bge-m3', 0)) = 1
      and (select count(*) from public.match_transcript_windows('33333333-3333-3333-3333-333333333333', $QUERY, '@cf/baai/bge-m3', -5)) = 1"
check "match_transcript_windows pins its search_path" \
  "select exists (select 1 from pg_proc
     where proname = 'match_transcript_windows'
       and proconfig @> array['search_path=public, extensions'])"

reject "a window with a vector of the wrong dimension is refused" \
  "insert into public.transcript_windows
     (meeting_id, idx, first_segment_idx, last_segment_idx, start_ms, end_ms, content, content_hash, model, embedding)
   values ('33333333-3333-3333-3333-333333333333', 9, 0, 1, 0, 1, 'x', '$HASH_A', '@cf/baai/bge-m3',
           array_fill(0.1::real, array[$((DIMENSIONS - 1))])::extensions.vector);" \
  "expected $DIMENSIONS dimensions, not $((DIMENSIONS - 1))"
reject "a window at the old 768 dimensions is refused" \
  "insert into public.transcript_windows
     (meeting_id, idx, first_segment_idx, last_segment_idx, start_ms, end_ms, content, content_hash, model, embedding)
   values ('33333333-3333-3333-3333-333333333333', 9, 0, 1, 0, 1, 'x', '$HASH_A', '@cf/baai/bge-m3',
           array_fill(0.1::real, array[768])::extensions.vector);" \
  "expected $DIMENSIONS dimensions, not 768"
reject "a window whose content hash is not SHA-256 hex is refused" \
  "insert into public.transcript_windows
     (meeting_id, idx, first_segment_idx, last_segment_idx, start_ms, end_ms, content, content_hash, model, embedding)
   values ('33333333-3333-3333-3333-333333333333', 9, 0, 1, 0, 1, 'x', 'not-a-hash', '@cf/baai/bge-m3', $(unit_vector 1));" \
  "violates check constraint \"transcript_windows_content_hash_check\""
reject "a window whose range ends before it starts is refused" \
  "insert into public.transcript_windows
     (meeting_id, idx, first_segment_idx, last_segment_idx, start_ms, end_ms, content, content_hash, model, embedding)
   values ('33333333-3333-3333-3333-333333333333', 9, 5, 4, 0, 1, 'x', '$HASH_A', '@cf/baai/bge-m3', $(unit_vector 1));" \
  "violates check constraint \"transcript_windows_check\""


psql -q -c "delete from public.meetings where audio_key='windows_a';"
check "deleting a meeting removes its windows, and only its windows" \
  "select (select count(*) from public.transcript_windows
           where meeting_id='33333333-3333-3333-3333-333333333333') = 0
      and (select count(*) from public.transcript_windows
           where meeting_id='44444444-4444-4444-4444-444444444444') = 1"
# Applied a second time: a re-run must not lose windows stored at the new size, and
# must leave the function callable, and callable only by whom it was.
psql -q < "$EMBEDDING_MIGRATION"
check "applying the embedding migration again keeps windows at the new size" \
  "select count(*) = 1 from public.transcript_windows where meeting_id='44444444-4444-4444-4444-444444444444'"
check "match_transcript_windows still answers after a second run" \
  "select count(*) = 1 from public.match_transcript_windows('44444444-4444-4444-4444-444444444444', $QUERY, '@cf/baai/bge-m3', 5)"
check_match_privileges "match_transcript_windows keeps its privileges after a second run"
psql -q -c "delete from public.meetings where audio_key in ('windows_b', 'legacy_window');"


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

# --- the run ledger (ADR-0012) ----------------------------------------------
# claim_step / release_step / plan_chunks / record_chunk / finalize_summary.
# Each case mirrors one in tests/unit/pipeline-ledger.spec.ts, which asserts the
# same rule against the local driver. As with the slot checks, every call is
# its OWN statement and keeps what it returned in vl_c, so the checks read the
# state the call committed rather than a snapshot from before it.
psql -q -c "create table vl_c (label text primary key, step_token uuid, run_id uuid, attempts integer);"
ledger_meeting() { # ledger_meeting <uuid> <status>
  psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
              values ('$1','t','$2','a.mp4',1,'ledger_$1',10);
              insert into public.transcript_segments (meeting_id, idx, start_ms, end_ms, text)
              select '$1', g, g * 1000, g * 1000 + 900, 'line ' || g from generate_series(0, 9) g;"
}
claim() { # claim <label> <meeting> <stage> <status> <lease_ms> [chunk_no|null] [new_run] [reset_attempts] ['move_to'|null] [redo] [expected_updated_at]
  psql -q -c "insert into vl_c select '$1', step_token, run_id, attempts
              from public.claim_step('$2', '$3', '$4', $5, ${6:-null}, ${7:-false}, ${8:-false}, ${9:-null}, ${10:-false}, ${11:-null});"
}
tok() { echo "(select step_token from vl_c where label = '$1')"; }
got() { echo "(select $2 from vl_c where label = '$1')"; }
claimed() { echo "exists (select 1 from vl_c where label = '$1')"; }
run_of() { echo "(select $2 from public.pipeline_runs where meeting_id = '$1' and stage = 'summarization')"; }
PLAN='[{"chunk_no":0,"seg_from":0,"seg_to":4,"est_tokens":900},{"chunk_no":1,"seg_from":5,"seg_to":9,"est_tokens":800}]'
RESULT='{"summary":"s","decisions":[],"actionItems":[],"droppedDecisions":0,"droppedActionItems":0}'
L1=a0000000-0000-0000-0000-000000000001   # claims and leases
L2=a0000000-0000-0000-0000-000000000002   # wrong status
L3=a0000000-0000-0000-0000-000000000003   # plan, record, finalize
L4=a0000000-0000-0000-0000-000000000004   # new run

check "pipeline_runs and summary_chunks have RLS on and no policies" \
  "select bool_and(c.relrowsecurity and not exists (select 1 from pg_policy where polrelid = c.oid)) and count(*) = 2
   from pg_class c where c.oid in ('public.pipeline_runs'::regclass, 'public.summary_chunks'::regclass)"

ledger_meeting "$L1" indexing
psql -q -c "create table vl_m as select updated_at from public.meetings where id = '$L1';"
claim first "$L1" summarization indexing 60000
claim second "$L1" summarization indexing 60000
check "claim_step grants the first claim as attempt 1, and refuses a second while its lease lives" \
  "select $(claimed first) and $(got first attempts) = 1 and not $(claimed second)"
check "claim_step moves the meeting's updated_at" \
  "select (select updated_at from public.meetings where id = '$L1') > (select updated_at from vl_m)"
claim other "$L1" search_index indexing 60000
check "claim_step leaves another stage of the same meeting free" "select $(claimed other)"

ledger_meeting "$L2" ready
psql -q -c "insert into vl_m select updated_at from public.meetings where id = '$L2';"
claim wrongstatus "$L2" summarization indexing 60000
check "claim_step claims nothing, creates no run and leaves updated_at alone in another status" \
  "select not $(claimed wrongstatus)
          and not exists (select 1 from public.pipeline_runs where meeting_id = '$L2')
          and (select updated_at from public.meetings where id = '$L2') = (select max(updated_at) from vl_m)"

psql -q -c "update public.pipeline_runs set step_lease_until = clock_timestamp() - interval '1 second'
            where meeting_id = '$L1' and stage = 'summarization';"
claim reclaim "$L1" summarization indexing 60000
check "claim_step re-claims an expired step under a new token, counting the killed attempt" \
  "select $(got reclaim attempts) = 2 and $(tok reclaim) <> $(tok first) and $(got reclaim run_id) = $(got first run_id)"

check "release_step does nothing for a token that is not the live one" \
  "select not public.release_step('$L1', 'summarization', $(tok first), 'x', null)"
psql -q -At -c "select public.release_step('$L1', 'summarization', $(tok reclaim), null, null);" >/dev/null
claim refundrun "$L1" summarization indexing 60000
psql -q -At -c "select public.release_step('$L1', 'summarization', $(tok refundrun), 'slot', null, true);" >/dev/null
check "release_step refunds a run claim's attempt when the step made no provider call" \
  "select $(got refundrun attempts) = 3 and $(run_of "$L1" attempts) = 2"
claim reclaim2 "$L1" summarization indexing 60000
psql -q -At -c "select public.release_step('$L1', 'summarization', $(tok reclaim2), 'busy', '2030-01-01');" >/dev/null
check "release_step ends the step and records why and when to try again" \
  "select $(run_of "$L1" step_token) is null and $(run_of "$L1" step_lease_until) is null
          and $(run_of "$L1" last_error) = 'busy' and $(run_of "$L1" retry_at) = '2030-01-01'"
reject "claim_step refuses a non-positive lease" \
  "select * from public.claim_step('$L1', 'summarization', 'indexing', 0)" "must be positive"
reject "pipeline_runs refuses a token without a lease, which would never expire" \
  "update public.pipeline_runs set step_token = gen_random_uuid() where meeting_id = '$L1' and stage = 'summarization'" \
  "pipeline_runs_token_has_lease"

ledger_meeting "$L3" indexing
claim plan "$L3" summarization indexing 60000
check "plan_chunks writes nothing under a token that is not the live one" \
  "select not public.plan_chunks('$L3', gen_random_uuid(), '$PLAN')
          and not exists (select 1 from public.summary_chunks where meeting_id = '$L3')"
psql -q -At -c "select public.plan_chunks('$L3', $(tok plan), '$PLAN');" >/dev/null
check "plan_chunks writes the plan and keeps the step's claim" \
  "select (select count(*) from public.summary_chunks where meeting_id = '$L3' and result is null) = 2
          and $(run_of "$L3" step_token) = $(tok plan)"
check "record_chunk records nothing for a chunk the plan does not have" \
  "select not public.record_chunk('$L3', $(tok plan), 5, 0, 9, '$RESULT')"
psql -q -At -c "select public.record_chunk('$L3', $(tok plan), 0, 0, 4, '$RESULT');" >/dev/null
check "record_chunk stores the result and ends the step" \
  "select (select result is not null from public.summary_chunks where meeting_id = '$L3' and chunk_no = 0)
          and $(run_of "$L3" step_token) is null"
check "record_chunk drops a straggler's write once its step has ended" \
  "select not public.record_chunk('$L3', $(tok plan), 1, 5, 9, '$RESULT')
          and (select result is null from public.summary_chunks where meeting_id = '$L3' and chunk_no = 1)"

claim replan "$L3" summarization indexing 60000
psql -q -At -c "select public.plan_chunks('$L3', $(tok replan), '[{\"chunk_no\":0,\"seg_from\":0,\"seg_to\":9,\"est_tokens\":1}]');" >/dev/null
check "plan_chunks keeps an existing plan for the same run, results and all" \
  "select (select count(*) from public.summary_chunks where meeting_id = '$L3') = 2
          and (select result is not null from public.summary_chunks where meeting_id = '$L3' and chunk_no = 0)"
psql -q -At -c "select public.release_step('$L3', 'summarization', $(tok replan), null, null);" >/dev/null

claim chunk1 "$L3" summarization indexing 60000 1
psql -q -c "update public.pipeline_runs set step_lease_until = clock_timestamp() - interval '1 second'
            where meeting_id = '$L3' and stage = 'summarization';"
claim chunk1again "$L3" summarization indexing 60000 1
check "claim_step counts a chunk claim on the chunk, not the run" \
  "select $(got chunk1 attempts) = 1 and $(got chunk1again attempts) = 2
          and (select attempts from public.summary_chunks where meeting_id = '$L3' and chunk_no = 0) = 0"
psql -q -At -c "select public.release_step('$L3', 'summarization', $(tok chunk1again), null, null);" >/dev/null
reject "claim_step refuses a chunk the plan does not have" \
  "select * from public.claim_step('$L3', 'summarization', 'indexing', 60000, 7)" "not in the current plan"
check "and holds no lease afterwards, the whole claim rolled back" \
  "select $(run_of "$L3" step_lease_until) is null"
check "record_chunk refuses a result for a segment range the chunk is not planned with" \
  "select not public.record_chunk('$L3', gen_random_uuid(), 1, 5, 9, '$RESULT')"
claim chunk1range "$L3" summarization indexing 60000 1
check "record_chunk records nothing when the range differs from the stored plan's" \
  "select not public.record_chunk('$L3', $(tok chunk1range), 1, 5, 8, '$RESULT')
          and (select result is null from public.summary_chunks where meeting_id = '$L3' and chunk_no = 1)"
psql -q -At -c "select public.release_step('$L3', 'summarization', $(tok chunk1range), null, null, true);" >/dev/null
check "release_step refunds a chunk claim's attempt when the step made no provider call" \
  "select (select attempts from public.summary_chunks where meeting_id = '$L3' and chunk_no = 1) = 2
          and $(run_of "$L3" step_chunk_no) is null"
claim donechunk "$L3" summarization indexing 60000 0
check "claim_step does not claim a chunk that already has its result, and holds no lease" \
  "select not $(claimed donechunk) and $(run_of "$L3" step_lease_until) is null
          and (select attempts from public.summary_chunks where meeting_id = '$L3' and chunk_no = 0) = 0"
claim resetchunk "$L3" summarization indexing 60000 1 false true
check "claim_step restarts a chunk's attempts on request, as when a failed run is retried" \
  "select $(got resetchunk attempts) = 1
          and (select attempts from public.summary_chunks where meeting_id = '$L3' and chunk_no = 1) = 1"
psql -q -At -c "select public.release_step('$L3', 'summarization', $(tok resetchunk), null, null);" >/dev/null
reject "a chunk is only recorded as the live step's claim when a token is live" \
  "update public.pipeline_runs set step_chunk_no = 1 where meeting_id = '$L3' and stage = 'summarization'" \
  "pipeline_runs_chunk_needs_step"

claim fin1 "$L3" summarization indexing 60000
reject "finalize_summary refuses while a chunk of the plan has no result" \
  "select public.finalize_summary('$L3', $(tok fin1), 's', 'stub', '[]', '[]')" "has no result yet"
psql -q -At -c "select public.record_chunk('$L3', $(tok fin1), 1, 5, 9, '$RESULT');" >/dev/null
claim fin2 "$L3" summarization indexing 60000
DECISIONS='[{"idx":0,"decision":"Ship","quote":"line 2","segment_idx":2,"start_ms":2000}]'
ACTIONS='[{"idx":0,"task":"Send","assignee":null,"due_date_text":"Friday","quote":"line 7","segment_idx":7,"start_ms":7000}]'
check "finalize_summary writes nothing under a token that is not the live one" \
  "select not public.finalize_summary('$L3', gen_random_uuid(), 's', 'stub', '$DECISIONS', '$ACTIONS')
          and not exists (select 1 from public.meeting_summaries where meeting_id = '$L3')"
psql -q -c "update public.meetings set status = 'failed', failed_stage = 'summarization' where id = '$L3';"
check "finalize_summary writes nothing once the meeting has left indexing" \
  "select not public.finalize_summary('$L3', $(tok fin2), 's', 'stub', '$DECISIONS', '$ACTIONS')
          and not exists (select 1 from public.meeting_summaries where meeting_id = '$L3')"
psql -q -c "update public.meetings set status = 'indexing', failed_stage = null where id = '$L3';"
psql -q -At -c "select public.finalize_summary('$L3', $(tok fin2), 'Shipping.', 'stub', '$DECISIONS', '$ACTIONS');" >/dev/null
check "finalize_summary writes the summary, its items and ready together, and ends the step" \
  "select (select status from public.meetings where id = '$L3') = 'ready'
          and (select summary from public.meeting_summaries where meeting_id = '$L3') = 'Shipping.'
          and (select decision from public.meeting_decisions where meeting_id = '$L3') = 'Ship'
          and (select assignee is null and due_date_text = 'Friday' from public.meeting_action_items where meeting_id = '$L3')
          and $(run_of "$L3" step_token) is null"

ledger_meeting "$L4" indexing
claim old "$L4" summarization indexing 60000
psql -q -At -c "select public.plan_chunks('$L4', $(tok old), '$PLAN');" >/dev/null
claim newwhilelive "$L4" summarization indexing 60000 null true
check "claim_step makes a new run wait for a live step of the old one" "select not $(claimed newwhilelive)"
psql -q -At -c "select public.record_chunk('$L4', $(tok old), 0, 0, 4, '$RESULT');" >/dev/null
claim fresh "$L4" summarization indexing 60000 null true
check "claim_step starts a new run on request, at attempt 0" \
  "select $(got fresh run_id) <> $(got old run_id) and $(got fresh attempts) = 0"
psql -q -At -c "select public.plan_chunks('$L4', $(tok fresh), '[{\"chunk_no\":0,\"seg_from\":0,\"seg_to\":9,\"est_tokens\":1700}]');" >/dev/null
check "plan_chunks replaces an older run's plan" \
  "select (select count(*) from public.summary_chunks where meeting_id = '$L4') = 1
          and (select seg_to = 9 and result is null and run_id = $(got fresh run_id) from public.summary_chunks where meeting_id = '$L4')"

# One lock order. A write by a step whose lease has just run out, racing a
# re-claim, used to take the run row and then the meeting while the claim took
# the meeting and then the run row: a deadlock. Session A here holds the
# meeting lock as claim_step does, then reaches for the run row; finalize must
# queue behind it rather than take the run row first.
L5=a0000000-0000-0000-0000-000000000005
ledger_meeting "$L5" indexing
claim dl "$L5" summarization indexing 60000
psql -q -At -c "select public.plan_chunks('$L5', $(tok dl), '[]');" >/dev/null
DLTOKEN=$(psql -At -c "select $(tok dl)")
psql -q -c "update public.pipeline_runs set step_lease_until = clock_timestamp() - interval '1 second' where meeting_id = '$L5';"
( psql -q -c "begin;
              select 1 from public.meetings where id = '$L5' for update;
              select pg_sleep(1.5);
              update public.pipeline_runs set updated_at = clock_timestamp() where meeting_id = '$L5';
              commit;" >/tmp/vl_a.out 2>&1; echo $? >/tmp/vl_a.rc ) &
sleep 0.5
psql -At -c "select public.finalize_summary('$L5', '$DLTOKEN', 's', 'stub', '[]', '[]');" >/tmp/vl_b.out 2>&1 && echo 0 >/tmp/vl_b.rc || echo 1 >/tmp/vl_b.rc
wait
check "a token-fenced write queues behind a claim holding the meeting lock instead of deadlocking with it" \
  "select $(cat /tmp/vl_a.rc) = 0 and $(cat /tmp/vl_b.rc) = 0 and $(grep -c deadlock /tmp/vl_a.out /tmp/vl_b.out | awk -F: '{s+=$2} END {print s+0}') = 0
          and (select status from public.meetings where id = '$L5') = 'ready'"
psql -q -c "delete from public.meetings where id = '$L5';"

# Step 6: entering a stage with the claim, the cursor, and failing under the token.
L6=a0000000-0000-0000-0000-000000000006
ledger_meeting "$L6" indexing
psql -q -c "update public.meetings set status = 'failed', failed_stage = 'summarization', error_message = 'boom' where id = '$L6';"
claim enter "$L6" summarization failed 60000 null false false "'indexing'"
check "claim_step moves the meeting into the stage with the claim, clearing the failure it leaves" \
  "select $(claimed enter) and (select status = 'indexing' and failed_stage is null and error_message is null
                               from public.meetings where id = '$L6')"
claim enterlive "$L6" summarization indexing 60000 null false false "'ready'"
check "claim_step moves nothing when the claim is refused" \
  "select not $(claimed enterlive) and (select status from public.meetings where id = '$L6') = 'indexing'"
psql -q -At -c "select public.release_step('$L6', 'summarization', $(tok enter), null, null, false, '{\"rateLimited\":{\"chunkNo\":1,\"count\":2}}');" >/dev/null
claim cur2 "$L6" summarization indexing 60000
reject "release_step refuses a cursor that is not a JSON object" \
  "select public.release_step('$L6', 'summarization', $(tok cur2), null, null, false, '[1, 2]')" "must be a JSON object"
psql -q -At -c "select public.release_step('$L6', 'summarization', $(tok cur2), null, null);" >/dev/null
check "release_step replaces the run's cursor when asked, and keeps it otherwise" \
  "select $(run_of "$L6" cursor) = '{\"rateLimited\":{\"chunkNo\":1,\"count\":2}}'::jsonb"
claim stale "$L6" summarization indexing 60000
psql -q -c "update public.pipeline_runs set step_lease_until = clock_timestamp() - interval '1 second'
            where meeting_id = '$L6' and stage = 'summarization';"
claim live "$L6" summarization indexing 60000
psql -q -c "insert into vl_c (label, attempts)
            select 'stalereleased', public.release_step('$L6', 'summarization', $(tok stale), 'late', null, false, null, 'indexing')::int;"
check "release_step does not fail the meeting under a token that is no longer live" \
  "select $(got stalereleased attempts) = 0 and (select status from public.meetings where id = '$L6') = 'indexing'"
reject "release_step refuses to fail the meeting from the search_index stage" \
  "select public.release_step('$L6', 'search_index', gen_random_uuid(), 'x', null, false, null, 'indexing')" "cannot fail the meeting"
psql -q -c "insert into vl_c (label, attempts)
            select 'failed', public.release_step('$L6', 'summarization', $(tok live), 'quota', null, false, null, 'indexing')::int;"
check "release_step fails the meeting for its stage under the live token" \
  "select $(got failed attempts) = 1
          and (select status = 'failed' and failed_stage = 'summarization' and error_message = 'quota'
                 from public.meetings where id = '$L6')"
claim leftstatus "$L6" summarization failed 60000
psql -q -c "update public.meetings set status = 'ready', failed_stage = null, error_message = null where id = '$L6';"
psql -q -c "insert into vl_c (label, attempts)
            select 'leftreleased', public.release_step('$L6', 'summarization', $(tok leftstatus), 'x', null, false, null, 'indexing')::int;"
check "release_step does not fail a meeting that has left the status it was to fail from" \
  "select $(got leftreleased attempts) = 1 and (select status from public.meetings where id = '$L6') = 'ready'"
psql -q -c "delete from public.meetings where id = '$L6';"

# A stored result that fails the read-back check is redone only on request.
L7=a0000000-0000-0000-0000-000000000007
ledger_meeting "$L7" indexing
claim r7 "$L7" summarization indexing 60000
psql -q -At -c "select public.plan_chunks('$L7', $(tok r7), '$PLAN');" >/dev/null
psql -q -At -c "select public.record_chunk('$L7', $(tok r7), 0, 0, 4, '$RESULT');" >/dev/null
psql -q -c "update public.summary_chunks set result = '{\"summary\":\"damaged\"}' where meeting_id = '$L7' and chunk_no = 0;"
claim noredo "$L7" summarization indexing 60000 0
claim redo "$L7" summarization indexing 60000 0 false false null true
check "claim_step claims a chunk with a stored result only with p_redo, which clears the result" \
  "select not $(claimed noredo) and $(claimed redo) and $(got redo attempts) = 1
          and (select result is null from public.summary_chunks where meeting_id = '$L7' and chunk_no = 0)"
psql -q -c "delete from public.meetings where id = '$L7';"

# Step 7: step-wise transcription. The twins of the appendSegments and
# finishTranscription cases in tests/unit/pipeline-ledger.spec.ts. Every call is
# its own statement: a call and a read of its effects in ONE statement would read
# the starting snapshot and pass whatever the function did.
append() { # append <label> <meeting> <token> <from> <segments-json> <cursor-json>
  psql -q -c "insert into vl_c (label, attempts)
              select '$1', public.append_segments('$2', $3, $4, '$5', '$6')::int;"
}
finish() { # finish <label> <meeting> <token> <chunks-json> [refusal literal]
  psql -q -c "insert into vl_c (label, attempts)
              select '$1', public.finish_transcription('$2', $3, '$4', ${5:-null})::int;"
}
line() { echo "{\"idx\":$1,\"start_ms\":$(($1 * 1000)),\"end_ms\":$(($1 * 1000 + 900)),\"text\":\"${2:-line $1}\"}"; }
tr_run() { echo "(select $2 from public.pipeline_runs where meeting_id = '$1' and stage = 'transcription')"; }
sum_run() { echo "(select $2 from public.pipeline_runs where meeting_id = '$1' and stage = 'summarization')"; }
seg_count() { echo "(select count(*) from public.transcript_segments where meeting_id = '$1')"; }
seg_text() { echo "(select text from public.transcript_segments where meeting_id = '$1' and idx = $2)"; }
empty_meeting() { # empty_meeting <uuid> <status>: no transcript yet
  psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
              values ('$1','t','$2','a.mp4',1,'ledger_$1',10);"
}

T1=a0000000-0000-0000-0000-000000000011   # pages
empty_meeting "$T1" uploaded
claim t1 "$T1" transcription uploaded 60000 null false true "'transcribing'"
check "claim_step enters transcription, counting the first claim as attempt 1" \
  "select $(claimed t1) and $(got t1 attempts) = 1
          and (select status from public.meetings where id = '$T1') = 'transcribing'"
append a1 "$T1" "$(tok t1)" 0 "[$(line 0),$(line 1),$(line 2)]" '{"at":1}'
check "append_segments stores the page and its cursor, and ends the step with its count started afresh" \
  "select $(got a1 attempts) = 1 and $(seg_count "$T1") = 3 and $(seg_text "$T1" 1) = 'line 1'
          and $(tr_run "$T1" cursor) = '{\"at\":1}'::jsonb and $(tr_run "$T1" step_token) is null
          and $(tr_run "$T1" step_lease_until) is null and $(tr_run "$T1" attempts) = 0"
claim t1b "$T1" transcription transcribing 60000
check "the next claim after a page counts from one" "select $(got t1b attempts) = 1"
append late "$T1" "$(tok t1)" 0 "[$(line 0 late)]" '{"at":9}'
check "append_segments writes nothing under a token that is not the live one" \
  "select $(got late attempts) = 0 and $(seg_text "$T1" 0) = 'line 0'
          and $(tr_run "$T1" cursor) = '{\"at\":1}'::jsonb and $(tr_run "$T1" step_token) is not null"
append a2 "$T1" "$(tok t1b)" 1 "[$(line 1 again)]" '{"at":2}'
check "append_segments replaces everything from the page's first index on, so a retried page replaces itself" \
  "select $(got a2 attempts) = 1 and $(seg_count "$T1") = 2 and $(seg_text "$T1" 0) = 'line 0'
          and $(seg_text "$T1" 1) = 'again'"
claim t1c "$T1" transcription transcribing 60000
append a3 "$T1" "$(tok t1c)" 0 "[]" '{"at":3}'
check "append_segments clears from the index with an empty page" \
  "select $(got a3 attempts) = 1 and $(seg_count "$T1") = 0"

claim t1d "$T1" transcription transcribing 60000
reject "append_segments refuses a page not numbered from its start" \
  "select public.append_segments('$T1', $(tok t1d), 1, '[$(line 0)]', '{}')" "numbered consecutively"
reject "append_segments refuses a gap inside a page" \
  "select public.append_segments('$T1', $(tok t1d), 0, '[$(line 0),$(line 2)]', '{}')" "numbered consecutively"
reject "append_segments refuses a negative start" \
  "select public.append_segments('$T1', $(tok t1d), -1, '[]', '{}')" "segment index"
reject "append_segments refuses a cursor that is not an object" \
  "select public.append_segments('$T1', $(tok t1d), 0, '[]', '[1]')" "must be a JSON object"
reject "append_segments refuses segments that are not an array" \
  "select public.append_segments('$T1', $(tok t1d), 0, '{}', '{}')" "must be a JSON array"
# The reason normalizeSegments cleans text, and a page checks its times first:
# refused every time, these would stop a page for good.
reject "append_segments refuses a NUL in the text" \
  "select public.append_segments('$T1', $(tok t1d), 0, '[{\"idx\":0,\"start_ms\":0,\"end_ms\":1,\"text\":\"a\\u0000b\"}]', '{}')" "unsupported Unicode escape"
reject "append_segments refuses a lone surrogate in the text" \
  "select public.append_segments('$T1', $(tok t1d), 0, '[{\"idx\":0,\"start_ms\":0,\"end_ms\":1,\"text\":\"\\ud83d\"}]', '{}')" "low surrogate"
reject "append_segments refuses a time past an integer" \
  "select public.append_segments('$T1', $(tok t1d), 0, '[{\"idx\":0,\"start_ms\":3000000000,\"end_ms\":3000000000,\"text\":\"x\"}]', '{}')" "out of range"

claim other7 "$T1" summarization transcribing 60000
append wrongstage "$T1" "$(tok other7)" 0 "[$(line 0)]" '{}'
finish wrongstagef "$T1" "$(tok other7)" '[]'
check "neither takes another stage's token" \
  "select $(got wrongstage attempts) = 0 and $(got wrongstagef attempts) = 0 and $(seg_count "$T1") = 0
          and (select status from public.meetings where id = '$T1') = 'transcribing'"

# A finished transcript is never replaced, even by a token still marked live.
T2=a0000000-0000-0000-0000-000000000012
empty_meeting "$T2" uploaded
claim t2 "$T2" transcription uploaded 60000 null false true "'transcribing'"
psql -q -c "insert into public.transcript_segments (meeting_id, idx, start_ms, end_ms, text) values ('$T2', 0, 0, 900, 'finished');"
psql -q -c "update public.meetings set status = 'ready' where id = '$T2';"
append past "$T2" "$(tok t2)" 0 "[$(line 0 overwrite)]" '{}'
finish pastf "$T2" "$(tok t2)" '[]'
check "a live token writes nothing once the meeting has left transcribing, and the transcript stays" \
  "select $(got past attempts) = 0 and $(got pastf attempts) = 0 and $(seg_text "$T2" 0) = 'finished'
          and (select status from public.meetings where id = '$T2') = 'ready'"

# Finishing: the plan, the new run and the status are one move.
T3=a0000000-0000-0000-0000-000000000013
empty_meeting "$T3" uploaded
claim t3 "$T3" transcription uploaded 60000 null false true "'transcribing'"
claim stale3 "$T3" summarization transcribing 60000
append a3p "$T3" "$(tok t3)" 0 "[$(line 0)]" '{"at":3}'
claim t3b "$T3" transcription transcribing 60000
psql -q -At -c "select public.plan_chunks('$T3', $(tok stale3), '[{\"chunk_no\":0,\"seg_from\":90,\"seg_to\":99,\"est_tokens\":1}]');" >/dev/null
finish f3 "$T3" "$(tok t3b)" "$PLAN"
check "finish_transcription starts a new extraction run with the plan, moves to summarizing and ends the step" \
  "select $(got f3 attempts) = 1
          and (select status = 'summarizing' and failed_stage is null and error_message is null
                 from public.meetings where id = '$T3')
          and $(sum_run "$T3" run_id) <> $(got stale3 run_id)
          and $(sum_run "$T3" step_token) is null and $(sum_run "$T3" attempts) = 0
          and $(tr_run "$T3" step_token) is null and $(tr_run "$T3" cursor) = '{}'::jsonb
          and (select count(*) = 2 and bool_and(run_id = $(sum_run "$T3" run_id)) and min(seg_from) = 0 and max(seg_to) = 9
                 from public.summary_chunks where meeting_id = '$T3')"
claim c3 "$T3" summarization summarizing 60000 0 false false "'indexing'"
check "extraction claims the first chunk of that plan, entering its stage" \
  "select $(claimed c3) and $(got c3 attempts) = 1 and (select status from public.meetings where id = '$T3') = 'indexing'"

T4=a0000000-0000-0000-0000-000000000014
empty_meeting "$T4" uploaded
claim t4 "$T4" transcription uploaded 60000 null false true "'transcribing'"
finish f4 "$T4" "$(tok t4)" "$PLAN" "'too long'"
check "with a refusal it writes no plan and moves to failed for summarization" \
  "select $(got f4 attempts) = 1
          and (select status = 'failed' and failed_stage = 'summarization' and error_message = 'too long'
                 from public.meetings where id = '$T4')
          and not exists (select 1 from public.summary_chunks where meeting_id = '$T4')"

T5=a0000000-0000-0000-0000-000000000015
empty_meeting "$T5" uploaded
claim t5 "$T5" transcription uploaded 60000 null false true "'transcribing'"
psql -q -At -c "select public.release_step('$T5', 'transcription', $(tok t5), null, null);" >/dev/null
finish f5 "$T5" "$(tok t5)" "$PLAN"
check "finish_transcription finishes nothing under a token that is not the live one" \
  "select $(got f5 attempts) = 0 and (select status from public.meetings where id = '$T5') = 'transcribing'
          and not exists (select 1 from public.summary_chunks where meeting_id = '$T5')"
# A stale retry out of `failed` cannot reopen what another caller has ended.
T6=a0000000-0000-0000-0000-000000000016
empty_meeting "$T6" uploaded
psql -q -c "update public.meetings set status = 'failed', failed_stage = 'summarization', error_message = 'too long' where id = '$T6';"
claim staleretry "$T6" transcription failed 60000 null false true "'transcribing'" false "'2000-01-01T00:00:00Z'::timestamptz"
check "claim_step claims nothing when the meeting has changed since p_expected_updated_at" \
  "select not $(claimed staleretry)
          and (select status = 'failed' and failed_stage = 'summarization' and error_message = 'too long'
                 from public.meetings where id = '$T6')"
claim freshretry "$T6" transcription failed 60000 null false true "'transcribing'" false "(select updated_at from public.meetings where id = '$T6')"
check "claim_step claims when the meeting is exactly as the caller read it" \
  "select $(claimed freshretry) and (select status from public.meetings where id = '$T6') = 'transcribing'"
psql -q -c "delete from public.meetings where id = '$T6';"

check "step 7's functions are not executable by PUBLIC, whose default grant would open them to anon" \
  "select count(*) = 3 and bool_and(not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0))
     from pg_proc p where p.proname in ('claim_step', 'append_segments', 'finish_transcription')"

psql -q -c "delete from public.meetings where id in ('$T1', '$T2', '$T3', '$T4', '$T5');"
check "deleting a meeting removes what transcription wrote" \
  "select not exists (select 1 from public.transcript_segments where meeting_id in ('$T1', '$T2', '$T3', '$T4', '$T5'))
          and not exists (select 1 from public.pipeline_runs where meeting_id in ('$T1', '$T2', '$T3', '$T4', '$T5'))"

# Step 8: step-wise indexing. The twins of the upsertWindows and finishIndex cases in
# tests/unit/pipeline-ledger.spec.ts.
INDEX_MIGRATION=supabase/migrations/20261103120000_search_index_steps.sql
[ -f "$INDEX_MIGRATION" ] || fail "$INDEX_MIGRATION is missing"
psql -q -c "create table vl_f (label text primary key, result text);"
VEC="[$(printf '0.1,%.0s' $(seq 1 1023))0.1]"
win() { # win <idx> <first segment> <last segment> [hash character]
  local hash
  hash=$(printf "${4:-a}%.0s" $(seq 1 64))
  echo "{\"idx\":$1,\"first_segment_idx\":$2,\"last_segment_idx\":$3,\"start_ms\":$(($2 * 1000)),\"end_ms\":$(($3 * 1000 + 900)),\"content\":\"window $1\",\"content_hash\":\"$hash\",\"embedding\":$VEC}"
}
upsert() { # upsert <label> <meeting> <token> <windows-json> <cursor-json> [model]
  psql -q -c "insert into vl_c (label, attempts)
              select '$1', public.upsert_windows('$2', $3, '$4', '$5', public.transcript_hash('$2'), '${6:-model-a}')::int;"
}
finish_idx() { # finish_idx <label> <meeting> <token> <window count> [model] [hash expression]
  psql -q -c "insert into vl_f select '$1', public.finish_index('$2', $3, ${6:-public.transcript_hash('$2')}, '${5:-model-a}', $4);"
}
result() { echo "(select result from vl_f where label = '$1')"; }
ix_run() { echo "(select $2 from public.pipeline_runs where meeting_id = '$1' and stage = 'search_index')"; }
ix_state() { echo "(select $2 from public.read_index_state('$1', '${3:-model-a}'))"; }
marker() { echo "(select $2 from public.meeting_index_state where meeting_id = '$1')"; }
windows_of() { echo "(select count(*) from public.transcript_windows where meeting_id = '$1')"; }
window_model() { echo "(select model from public.transcript_windows where meeting_id = '$1' and idx = $2)"; }

check "meeting_index_state has RLS on and no policies" \
  "select c.relrowsecurity and not exists (select 1 from pg_policy where polrelid = c.oid)
   from pg_class c where c.oid = 'public.meeting_index_state'::regclass"

I1=a0000000-0000-0000-0000-000000000021   # batches, the fence and finishing
ledger_meeting "$I1" ready
check "read_index_state answers one row for a meeting with no marker: a meeting indexed before this reads as not complete" \
  "select count(*) = 1 and bool_and(text_hash is null and model is null and window_count is null and complete is null
             and current_hash ~ '^[0-9a-f]{64}\$' and segment_count = 10 and stored_windows = 0 and stored_for_model = 0)
     from public.read_index_state('$I1', 'model-a')"
claim i1 "$I1" search_index ready 60000
upsert u1 "$I1" "$(tok i1)" "[$(win 0 0 4)]" '{"at":1}'
check "upsert_windows stores the batch and its cursor, marks the index incomplete, and ends the step with its count started afresh" \
  "select $(got u1 attempts) = 1 and $(windows_of "$I1") = 1 and $(window_model "$I1" 0) = 'model-a'
          and $(ix_run "$I1" cursor) = '{\"at\":1}'::jsonb and $(ix_run "$I1" step_token) is null
          and $(ix_run "$I1" step_lease_until) is null and $(ix_run "$I1" attempts) = 0
          and $(marker "$I1" complete) = false and $(marker "$I1" model) = 'model-a' and $(marker "$I1" window_count) = 0
          and $(marker "$I1" text_hash) = public.transcript_hash('$I1')"
claim i1b "$I1" search_index ready 60000
check "the next claim after a batch counts from one" "select $(got i1b attempts) = 1"
upsert i1late "$I1" "$(tok i1)" "[$(win 1 4 9)]" '{"at":9}'
check "upsert_windows writes nothing under a token that is not the live one" \
  "select $(got i1late attempts) = 0 and $(windows_of "$I1") = 1
          and $(ix_run "$I1" cursor) = '{\"at\":1}'::jsonb and $(ix_run "$I1" step_token) is not null"
claim i1s "$I1" summarization ready 60000
upsert wrongstage8 "$I1" "$(tok i1s)" "[$(win 1 4 9)]" '{"at":8}'
finish_idx wrongstage8f "$I1" "$(tok i1s)" 1
check "neither takes another stage's token" \
  "select $(got wrongstage8 attempts) = 0 and $(result wrongstage8f) = 'lost' and $(windows_of "$I1") = 1"
psql -q -At -c "select public.release_step('$I1', 'summarization', $(tok i1s), null, null);" >/dev/null
reject "upsert_windows refuses windows that are not an array" \
  "select public.upsert_windows('$I1', $(tok i1b), '{}', '{}', public.transcript_hash('$I1'), 'model-a')" "must be a JSON array"
reject "upsert_windows refuses a cursor that is not an object" \
  "select public.upsert_windows('$I1', $(tok i1b), '[]', '[1]', public.transcript_hash('$I1'), 'model-a')" "must be a JSON object"
reject "upsert_windows refuses a vector of another size" \
  "select public.upsert_windows('$I1', $(tok i1b), '[{\"idx\":3,\"first_segment_idx\":0,\"last_segment_idx\":1,\"start_ms\":0,\"end_ms\":1,\"content\":\"x\",\"content_hash\":\"$(printf 'a%.0s' $(seq 1 64))\",\"embedding\":[1,2]}]', '{}', public.transcript_hash('$I1'), 'model-a')" "expected 1024 dimensions"
check "a refused batch leaves everything as it was, the step still live" \
  "select $(windows_of "$I1") = 1 and $(ix_run "$I1" step_token) = $(tok i1b) and $(ix_run "$I1" cursor) = '{\"at\":1}'::jsonb"
reject "finish_index refuses a negative count" \
  "select public.finish_index('$I1', $(tok i1b), public.transcript_hash('$I1'), 'model-a', -1)" "must not be negative"

finish_idx hole "$I1" "$(tok i1b)" 2
check "finish_index refuses a plan with a hole in it, and the step stays live" \
  "select $(result hole) = 'changed' and $(marker "$I1" complete) = false and $(ix_run "$I1" step_token) = $(tok i1b)"
upsert u2 "$I1" "$(tok i1b)" "[$(win 1 4 9)]" '{"at":2}'
claim i1c "$I1" search_index ready 60000
upsert empty8 "$I1" "$(tok i1c)" "[]" '{"at":3}'
check "an empty batch stores only the cursor, for a step that found everything stored" \
  "select $(got empty8 attempts) = 1 and $(windows_of "$I1") = 2 and $(ix_run "$I1" cursor) = '{\"at\":3}'::jsonb and $(ix_run "$I1" step_token) is null"
claim i1d "$I1" search_index ready 60000
finish_idx wronghash "$I1" "$(tok i1d)" 2 model-a "'$(printf 'b%.0s' $(seq 1 64))'"
check "finish_index refuses a transcript that is not the one this run planned" \
  "select $(result wronghash) = 'changed' and $(marker "$I1" complete) = false"
finish_idx short "$I1" "$(tok i1d)" 1
check "finish_index refuses a plan that does not reach the transcript's last line, whatever it holds" \
  "select $(result short) = 'changed' and $(marker "$I1" complete) = false and $(windows_of "$I1") = 2"
finish_idx wrongmodel "$I1" "$(tok i1d)" 2 model-b
check "finish_index refuses windows of another model" \
  "select $(result wrongmodel) = 'changed' and $(marker "$I1" complete) = false"
finish_idx done1 "$I1" "$(tok i1d)" 2
check "finish_index marks the index complete and ends the step, clearing the cursor" \
  "select $(result done1) = 'complete' and $(marker "$I1" complete) and $(marker "$I1" window_count) = 2
          and $(ix_run "$I1" step_token) is null and $(ix_run "$I1" cursor) = '{}'::jsonb and $(ix_run "$I1" attempts) = 0
          and $(ix_state "$I1" stored_windows) = 2 and $(ix_state "$I1" stored_for_model) = 2
          and $(ix_state "$I1" current_hash) = $(marker "$I1" text_hash)"
finish_idx late2 "$I1" "$(tok i1d)" 2
check "finish_index answers lost under a token that is not the live one" "select $(result late2) = 'lost'"
claim i1e "$I1" search_index ready 60000
upsert u3 "$I1" "$(tok i1e)" "[]" '{}'
check "the first write of a new run takes the marker back to incomplete, before anything has changed" \
  "select $(marker "$I1" complete) = false and $(marker "$I1" window_count) = 0 and $(windows_of "$I1") = 2"

# What the fingerprint notices.
psql -q -c "create table vl_h as select public.transcript_hash('$I1') as hash;"
HASH="(select hash from vl_h)"
same_hash() { # same_hash <description> <statement that changes it> <statement that puts it back>
  psql -q -c "$2"
  check "transcript_hash changes with $1" "select public.transcript_hash('$I1') <> $HASH"
  psql -q -c "$3"
  check "transcript_hash comes back when $1 does" "select public.transcript_hash('$I1') = $HASH"
}
same_hash "a line's text" "update public.transcript_segments set text = 'other' where meeting_id = '$I1' and idx = 5;" \
  "update public.transcript_segments set text = 'line 5' where meeting_id = '$I1' and idx = 5;"
same_hash "a line's time" "update public.transcript_segments set start_ms = 5001 where meeting_id = '$I1' and idx = 5;" \
  "update public.transcript_segments set start_ms = 5000 where meeting_id = '$I1' and idx = 5;"
same_hash "a line's end" "update public.transcript_segments set end_ms = 5901 where meeting_id = '$I1' and idx = 5;" \
  "update public.transcript_segments set end_ms = 5900 where meeting_id = '$I1' and idx = 5;"
same_hash "a line's position" "update public.transcript_segments set idx = 90 where meeting_id = '$I1' and idx = 9;" \
  "update public.transcript_segments set idx = 9 where meeting_id = '$I1' and idx = 90;"
check "transcript_hash of no lines is the hash of nothing, the same as the local driver's" \
  "select public.transcript_hash(gen_random_uuid()) = encode(sha256(''::bytea), 'hex')"

# Another model's index is replaced a batch at a time. Nothing removes it whole.
I2=a0000000-0000-0000-0000-000000000022
ledger_meeting "$I2" ready
claim i2 "$I2" search_index ready 60000
upsert i2a "$I2" "$(tok i2)" "[$(win 0 0 4),$(win 1 4 7),$(win 2 7 9)]" '{}' model-old
claim i2b "$I2" search_index ready 60000
finish_idx i2done "$I2" "$(tok i2b)" 3 model-old
check "an index finished under one model reads as stored for that model and not for another" \
  "select $(result i2done) = 'complete' and $(ix_state "$I2" stored_for_model model-old) = 3 and $(ix_state "$I2" stored_for_model) = 0
          and $(ix_state "$I2" stored_windows) = 3"
claim i2c "$I2" search_index ready 60000
upsert i2d "$I2" "$(tok i2c)" "[$(win 0 0 9 b)]" '{}'
check "a batch under another model replaces only its own windows, and leaves the rest of the old index stored" \
  "select $(windows_of "$I2") = 3 and $(window_model "$I2" 0) = 'model-a' and $(window_model "$I2" 1) = 'model-old'
          and $(marker "$I2" model) = 'model-a' and $(marker "$I2" complete) = false"
claim i2e "$I2" search_index ready 60000
finish_idx i2f "$I2" "$(tok i2e)" 1
check "finishing removes only what is past the plan's end, leaving no window of the old model" \
  "select $(result i2f) = 'complete' and $(windows_of "$I2") = 1 and $(window_model "$I2" 0) = 'model-a'
          and $(marker "$I2" window_count) = 1"

# A hole with both ends in place: only the count can see it.
I5=a0000000-0000-0000-0000-000000000025
ledger_meeting "$I5" ready
claim i5 "$I5" search_index ready 60000
upsert i5a "$I5" "$(tok i5)" "[$(win 0 0 4),$(win 2 7 9)]" '{}'
claim i5b "$I5" search_index ready 60000
finish_idx i5hole "$I5" "$(tok i5b)" 3
check "finish_index refuses a hole in the middle of a plan whose last window does reach the end" \
  "select $(result i5hole) = 'changed' and $(marker "$I5" complete) = false"
psql -q -c "delete from public.meetings where id = '$I5';"

# A transcript with no lines.
I3=a0000000-0000-0000-0000-000000000023
empty_meeting "$I3" ready
claim i3 "$I3" search_index ready 60000
finish_idx i3f "$I3" "$(tok i3)" 0
check "a transcript with no lines finishes with no windows" \
  "select $(result i3f) = 'complete' and $(marker "$I3" window_count) = 0 and $(marker "$I3" complete)"
claim i1f "$I2" search_index ready 60000
finish_idx i2zero "$I2" "$(tok i1f)" 0
check "a plan of no windows does not finish a transcript that has lines" \
  "select $(result i2zero) = 'changed' and $(windows_of "$I2") = 1"
psql -q -At -c "select public.release_step('$I2', 'search_index', $(tok i1f), null, null);" >/dev/null

# A straggler whose step is re-claimed while it waits for the lock.
I4=a0000000-0000-0000-0000-000000000024
ledger_meeting "$I4" ready
claim straggler "$I4" search_index ready 60000
psql -q -c "update public.pipeline_runs set step_lease_until = clock_timestamp() - interval '1 second'
            where meeting_id = '$I4' and stage = 'search_index';"
STRAGGLER=$(psql -At -c "select step_token from vl_c where label = 'straggler'")
( psql -q -c "begin;
              select * from public.claim_step('$I4', 'search_index', 'ready', 60000);
              select pg_sleep(1.5);
              commit;" >/tmp/vi_a.out 2>&1; echo $? >/tmp/vi_a.rc ) &
sleep 0.5
psql -At -c "select public.upsert_windows('$I4', '$STRAGGLER', '[$(win 0 0 9)]', '{\"at\":1}', public.transcript_hash('$I4'), 'model-a');" >/tmp/vi_b.out 2>&1 && echo 0 >/tmp/vi_b.rc || echo 1 >/tmp/vi_b.rc
wait
check "a write by a lost lease queues behind the re-claim and then writes nothing" \
  "select $(cat /tmp/vi_a.rc) = 0 and $(cat /tmp/vi_b.rc) = 0 and '$(tr -d '[:space:]' </tmp/vi_b.out)' = 'f'
          and $(windows_of "$I4") = 0 and not exists (select 1 from public.meeting_index_state where meeting_id = '$I4')
          and $(ix_run "$I4" cursor) = '{}'::jsonb and $(ix_run "$I4" step_token) is not null"

# Deleted while a step was out: the cascade leaves it nothing to write into.
claim i4 "$I1" search_index ready 60000
psql -q -c "delete from public.meetings where id = '$I1';"
upsert gone "$I1" "$(tok i4)" "[$(win 0 0 4)]" '{}'
finish_idx gonef "$I1" "$(tok i4)" 1
check "deleting a meeting removes its marker, windows and run, and a straggler writes nothing back" \
  "select $(got gone attempts) = 0 and $(result gonef) = 'lost' and $(windows_of "$I1") = 0
          and not exists (select 1 from public.meeting_index_state where meeting_id = '$I1')
          and not exists (select 1 from public.pipeline_runs where meeting_id = '$I1')"

for fn in 'public.transcript_hash(uuid)' 'public.read_index_state(uuid, text)' \
          'public.upsert_windows(uuid, uuid, jsonb, jsonb, text, text)' 'public.finish_index(uuid, uuid, text, text, integer)'; do
  check "$fn is executable by the service role and not by anon, authenticated or PUBLIC" \
    "select not has_function_privilege('anon', '$fn', 'execute')
        and not has_function_privilege('authenticated', '$fn', 'execute')
        and has_function_privilege('service_role', '$fn', 'execute')
        and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where p.oid = '$fn'::regprocedure and a.grantee = 0)"
done
check "step 8's functions pin their search_path" \
  "select bool_and('search_path=public' = any(proconfig)) and count(*) = 4 from pg_proc
   where proname in ('transcript_hash', 'read_index_state', 'upsert_windows', 'finish_index')"

# What a batch and a last step write reaches this meeting's indexing run and no other
# run: not the same meeting's other stage, and not another meeting.
I6=a0000000-0000-0000-0000-000000000026   # the meeting being indexed
I7=a0000000-0000-0000-0000-000000000027   # another meeting, with its own index and a live step
ledger_meeting "$I6" ready
ledger_meeting "$I7" ready
claim i7 "$I7" search_index ready 60000
upsert i7a "$I7" "$(tok i7)" "[$(win 0 0 4),$(win 1 4 7),$(win 2 7 9)]" '{}'
claim i7b "$I7" search_index ready 60000
finish_idx i7c "$I7" "$(tok i7b)" 3
claim i7d "$I7" search_index ready 60000
claim i6s "$I6" summarization ready 60000
psql -q -c "update public.pipeline_runs set cursor = '{\"mine\":1}'
            where (meeting_id = '$I7' and stage = 'search_index') or (meeting_id = '$I6' and stage = 'summarization');"
untouched() { # untouched <what just ran>
  check "$1 leaves the meeting's other stage and another meeting's run, windows and marker as they were" \
    "select $(run_of "$I6" step_token) = $(tok i6s) and $(run_of "$I6" cursor) = '{\"mine\":1}'::jsonb
            and $(ix_run "$I7" step_token) = $(tok i7d) and $(ix_run "$I7" cursor) = '{\"mine\":1}'::jsonb
            and $(windows_of "$I7") = 3 and $(marker "$I7" complete) and $(marker "$I7" window_count) = 3"
}
claim i6 "$I6" search_index ready 60000
upsert i6a "$I6" "$(tok i6)" "[$(win 0 0 4),$(win 1 4 9)]" '{}'
untouched "upsert_windows"
claim i6b "$I6" search_index ready 60000
finish_idx i6c "$I6" "$(tok i6b)" 2
check "the meeting's own index finished" "select $(result i6c) = 'complete'"
# Its plan is shorter than the other meeting's: past its end is index 2 there.
untouched "finish_index"

# A shorter plan under the same model, and every column of a window it replaces.
VEC2="[$(printf '0.2,%.0s' $(seq 1 1023))0.2]"
HASH2=$(printf 'b%.0s' $(seq 1 64))
claim i6d "$I6" search_index ready 60000
upsert i6e "$I6" "$(tok i6d)" "[{\"idx\":0,\"first_segment_idx\":1,\"last_segment_idx\":9,\"start_ms\":1234,\"end_ms\":9876,\"content\":\"replaced\",\"content_hash\":\"$HASH2\",\"embedding\":$VEC2}]" '{}'
check "a batch replaces every column of a stored window, its vector included" \
  "select first_segment_idx = 1 and last_segment_idx = 9 and start_ms = 1234 and end_ms = 9876 and content = 'replaced'
          and content_hash = '$HASH2' and model = 'model-a' and embedding::text = '$VEC2'
     from public.transcript_windows where meeting_id = '$I6' and idx = 0"
claim i6f "$I6" search_index ready 60000
finish_idx i6g "$I6" "$(tok i6f)" 1
check "a shorter plan under the same model finishes, removing what is past its end" \
  "select $(result i6g) = 'complete' and $(windows_of "$I6") = 1 and $(marker "$I6" window_count) = 1"
psql -q -At -c "select public.release_step('$I6', 'summarization', $(tok i6s), null, null);" >/dev/null
psql -q -c "delete from public.meetings where id in ('$I6', '$I7');"

# Repeatable: a second apply fails on nothing and changes no row.
psql -q -c "create table vl_s as select * from public.meeting_index_state;"
psql -q < "$INDEX_MIGRATION"
check "applying step 8's migration again keeps every marker, and the indexes stay usable" \
  "select not exists (select * from vl_s except select * from public.meeting_index_state)
          and not exists (select * from public.meeting_index_state except select * from vl_s)
          and (select count(*) from vl_s) > 0
          and $(ix_state "$I2" stored_for_model) = 1
          and not has_function_privilege('anon', 'public.finish_index(uuid, uuid, text, text, integer)', 'execute')"
psql -q -c "delete from public.meetings where id in ('$I2', '$I3', '$I4'); drop table vl_f; drop table vl_h; drop table vl_s;"

check "the ledger functions pin their search_path" \
  "select bool_and('search_path=public' = any(proconfig)) and count(*) = 8 from pg_proc
   where proname in ('claim_step', 'release_step', 'locked_step_run', 'plan_chunks', 'record_chunk', 'finalize_summary',
                     'append_segments', 'finish_transcription')"
psql -q -c "delete from public.meetings where id in ('$L1', '$L2', '$L3', '$L4');"
check "deleting a meeting removes its runs and chunks" \
  "select not exists (select 1 from public.pipeline_runs where meeting_id in ('$L1', '$L3', '$L4'))
          and not exists (select 1 from public.summary_chunks where meeting_id in ('$L3', '$L4'))"
psql -q -c "drop table vl_c; drop table vl_m;"

echo "checking the sweeper (ADR-0012, step 11) ..."
SWEEP_MIGRATION=supabase/migrations/20261103180000_sweeper.sql
LIMIT_ERROR='the daily limit'
# Everything above has left meetings of its own, and this is about which of them gets chosen.
psql -q -c "delete from public.meetings; delete from public.provider_slots;
            update public.sweep_state set last_created_at = null, last_meeting_id = null;"
pick() { # pick [exclude]: the meeting a tick chooses, or none
  psql -At -c "select coalesce(meeting_id::text, 'none') from public.sweep_next_meeting('model-a', ${1:-null}, '$LIMIT_ERROR');"
}
busy() { psql -At -c "select busy from public.sweep_next_meeting('model-a', null, '$LIMIT_ERROR');"; }
mk() { # mk <id> <status> [failed stage] [seconds old]
  psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes,failed_stage,created_at)
              values ('$1','x','$2','a.mp4',1,'sweep_$1',10,${3:-null},now() - make_interval(secs => ${4:-0}));"
}
lines() { psql -q -c "insert into public.transcript_segments (meeting_id, idx, start_ms, end_ms, text) values ('$1', 0, 0, 1000, 'hello');"; }
gone() { psql -q -c "delete from public.meetings where id = '$1';"; }
expect_pick() { # expect_pick <description> <id or none> [exclude]
  local got
  got=$(pick "${3:-null}")
  [ "$got" = "$2" ] || fail "$1 (got '$got')"
  echo "  ok: $1"
}
SW1=11111111-1111-4111-8111-111111111111
SW2=22222222-2222-4222-8222-222222222222
SW3=33333333-3333-4333-8333-333333333333

check "there is one sweep_state row, and RLS is on with no policies" \
  "select count(*) = 1 from public.sweep_state where id"
check "row-level security is on the sweep state, with no policy" \
  "select relrowsecurity and (select count(*) from pg_policies where tablename = 'sweep_state') = 0
   from pg_class where relname = 'sweep_state'"
reject "a second sweep_state row is refused" "insert into public.sweep_state (id) values (false);" "violates check constraint"
reject "a model is required" "select public.sweep_next_meeting(null, null, 'x');" "a model is required"

# The keep-alive: with nothing at all to do, a real write still reaches Postgres.
psql -q -c "update public.sweep_state set last_tick_at = now() - interval '1 day';"
expect_pick "nothing to do answers no meeting" none
check "a tick with nothing to do still moves last_tick_at, which is what keeps the project awake" \
  "select last_tick_at > now() - interval '1 minute' from public.sweep_state"
check "it answers exactly one row, meeting or not" \
  "select count(*) = 1 from public.sweep_next_meeting('model-a', null, '$LIMIT_ERROR')"

# The cases that matter most, as SQL. Every one of them, through PostgREST and the real driver and
# beside the local driver and the step decision: `pnpm test:postgrest`.
mk "$SW1" pending_upload
expect_pick "a pending upload cannot move" none
gone "$SW1"
mk "$SW1" uploaded
expect_pick "an uploaded meeting can" "$SW1"
expect_pick "the demo is left out, however ready" none "'$SW1'"
psql -q -c "select public.note_rate_limit('groq-whisper', 60000);" >/dev/null
expect_pick "an uploaded meeting cannot move while Whisper is blocked" none
check "and the block is named" "select 'groq-whisper' = any(busy) from public.sweep_next_meeting('model-a', null, '$LIMIT_ERROR')"
psql -q -c "delete from public.provider_slots;"
gone "$SW1"

mk "$SW1" failed "'transcription'" 3600
expect_pick "a failed transcription is not retried, however long ago" none
gone "$SW1"
mk "$SW1" failed "'upload'" 3600
expect_pick "a rejected upload is not moved" none
gone "$SW1"

mk "$SW1" summarizing
lines "$SW1"
expect_pick "a transcript with no plan is planned" "$SW1"
psql -q -c "select public.reserve_slot('groq-chat', 60000, 0);" >/dev/null
expect_pick "planning asks no provider, so a taken slot does not stop it" "$SW1"
psql -q -c "insert into public.pipeline_runs (meeting_id, stage) values ('$SW1', 'summarization');
            insert into public.summary_chunks (meeting_id, chunk_no, run_id, seg_from, seg_to, est_tokens)
              select '$SW1', 0, run_id, 0, 0, 1 from public.pipeline_runs where meeting_id = '$SW1' and stage = 'summarization';
            insert into public.pipeline_runs (meeting_id, stage, retry_at) values ('$SW1', 'search_index', now() + interval '1 minute');"
expect_pick "a chunk is not chosen with its slot taken, and the index parked" none
psql -q -c "update public.pipeline_runs set retry_at = null where meeting_id = '$SW1' and stage = 'search_index';"
expect_pick "with its slot taken and the index free, the meeting can still move" "$SW1"
psql -q -c "delete from public.provider_slots;
            update public.pipeline_runs set retry_at = now() + interval '1 minute' where meeting_id = '$SW1' and stage = 'summarization';
            update public.pipeline_runs set step_token = gen_random_uuid(), step_lease_until = now() + interval '1 minute' where meeting_id = '$SW1' and stage = 'search_index';"
expect_pick "a parked chunk and a live index step cannot move" none
psql -q -c "update public.pipeline_runs set retry_at = null where meeting_id = '$SW1' and stage = 'summarization';"
expect_pick "a chunk with its slot free can, beside a live index step" "$SW1"
psql -q -c "update public.summary_chunks set result = '{}' where meeting_id = '$SW1';
            update public.provider_slots set blocked_until = now() + interval '1 hour';
            select public.reserve_slot('groq-chat', 60000, 0);
            select public.note_rate_limit('groq-chat', 60000);
            select public.note_rate_limit('workers-ai-embed', 60000);" >/dev/null
expect_pick "every chunk done, the summary is written with both providers blocked" "$SW1"
psql -q -c "delete from public.provider_slots;"
gone "$SW1"

mk "$SW1" failed "'summarization'" 3600
lines "$SW1"
expect_pick "a failed extraction's index goes on" "$SW1"
gone "$SW1"
mk "$SW1" ready
expect_pick "a finished meeting with no lines has nothing left" none
lines "$SW1"
expect_pick "a finished meeting whose index never started can move" "$SW1"
psql -q -c "select public.note_rate_limit('workers-ai-embed', 60000);" >/dev/null
expect_pick "not while Workers AI is blocked" none
psql -q -c "delete from public.provider_slots;
            insert into public.pipeline_runs (meeting_id, stage, last_error, retry_at) values ('$SW1', 'search_index', 'it broke', now() - interval '1 hour');"
expect_pick "not after a failure, however long ago: an index has no failed to stop in" none
psql -q -c "update public.pipeline_runs set last_error = '$LIMIT_ERROR', retry_at = now() + interval '1 hour' where meeting_id = '$SW1';"
expect_pick "not during the daily limit" none
psql -q -c "update public.pipeline_runs set retry_at = now() - interval '1 second' where meeting_id = '$SW1';"
expect_pick "but once it has passed" "$SW1"
psql -q -c "update public.pipeline_runs set retry_at = null where meeting_id = '$SW1';"
expect_pick "and not when the limit has no time to end at" none
psql -q -c "update public.pipeline_runs set last_error = null, cursor = '{\"pass\":{\"model\":\"model-b\"}}' where meeting_id = '$SW1';"
expect_pick "not with a pass of another model on the run" none
psql -q -c "delete from public.pipeline_runs where meeting_id = '$SW1';
            insert into public.meeting_index_state (meeting_id, text_hash, model, complete) values ('$SW1', '$(printf 'a%.0s' $(seq 1 64))', 'model-b', false);"
expect_pick "not with a marker of another model" none
psql -q -c "update public.meeting_index_state set model = 'model-a', complete = true where meeting_id = '$SW1';"
expect_pick "not with a complete marker" none
psql -q -c "update public.meeting_index_state set complete = false where meeting_id = '$SW1';"
expect_pick "but part way under this model, it can" "$SW1"
psql -q -c "insert into public.transcript_windows (meeting_id, idx, first_segment_idx, last_segment_idx, start_ms, end_ms, content, content_hash, model, embedding)
            values ('$SW1', 0, 0, 0, 0, 1, 'w', '$(printf 'a%.0s' $(seq 1 64))', 'model-b', array_fill(0.1::real, array[1024])::extensions.vector);"
expect_pick "not with another model's window stored" none
gone "$SW1"

# Whisper reserves no slot, so a slot taken on it is no reason, and only a block is.
check "busy names no provider that can be asked" \
  "select busy = '{}' from public.sweep_next_meeting('model-a', null, '$LIMIT_ERROR')"
psql -q -c "select public.reserve_slot('groq-whisper', 60000, 0); select public.reserve_slot('workers-ai-embed', 60000, 0);" >/dev/null
[ "$(busy)" = "{workers-ai-embed}" ] || fail "only a block counts for Whisper, and a slot for the others (got '$(busy)')"
echo "  ok: only a block counts for Whisper, and a taken slot for the others"
psql -q -c "delete from public.provider_slots; update public.sweep_state set last_created_at = null, last_meeting_id = null;"

# Rotation, from what is stored, whichever session asks.
mk "$SW1" uploaded null 300
mk "$SW2" uploaded null 200
mk "$SW3" uploaded null 100
expect_pick "the first meeting first" "$SW1"
expect_pick "then the next, with nothing done to the first" "$SW2"
expect_pick "then the last" "$SW3"
expect_pick "then back to the first" "$SW1"
gone "$SW2"
expect_pick "a meeting deleted out of the rotation does not stop it" "$SW3"
gone "$SW3"
expect_pick "nor one deleted as the last chosen" "$SW1"
mk "$SW2" uploaded null 200
expect_pick "a new meeting takes its turn" "$SW2"

# Two ticks at once. Each waits for the other's row lock, then chooses from where it left off.
for tries in 1 2 3; do
  pick > "$TMPDIR_SWEEP/a" & pid=$!
  pick > "$TMPDIR_SWEEP/b"
  wait "$pid"
  [ "$(cat "$TMPDIR_SWEEP/a")" != "$(cat "$TMPDIR_SWEEP/b")" ] || fail "two ticks at once chose the same meeting: $(cat "$TMPDIR_SWEEP/a")"
done
echo "  ok: two ticks at once choose different meetings"
gone "$SW1"
gone "$SW2"

# What a tick reads. Counted by Postgres itself, in the tick's own transaction, on the tables a
# tick reads rather than the two rows it locks, once with many meetings and once with more. Not
# with few: on a table of a few hundred rows a scan is the cheaper plan, and Postgres takes it.
rows_read() {
  psql -q -At -c "begin;
    select count(*) from public.sweep_next_meeting('model-a', null, '$LIMIT_ERROR');
    select coalesce(sum(coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0)), 0) || ' ' || coalesce(sum(seq_scan), 0)
      from pg_stat_xact_user_tables
     where relname in ('meetings', 'pipeline_runs', 'meeting_index_state', 'summary_chunks', 'transcript_windows', 'transcript_segments');
    rollback;" | tail -1
}
finished_meetings() { # finished_meetings <from> <to>: each ready, with a complete marker
  psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
                select gen_random_uuid(), 'x', 'ready', 'a.mp4', 1, 'sweep_read_' || g, 10 from generate_series($1, $2) g;
              insert into public.meeting_index_state (meeting_id, text_hash, model, window_count, complete)
                select m.id, '$(printf 'a%.0s' $(seq 1 64))', 'model-a', 0, true from public.meetings m
                 where m.audio_key like 'sweep_read_%' and not exists (select 1 from public.meeting_index_state x where x.meeting_id = m.id);
              analyze public.meetings; analyze public.meeting_index_state;"
}
finished_meetings 1 5000
read_few=$(rows_read)
finished_meetings 5001 20000
read_many=$(rows_read)
echo "  (rows read by a tick, then scans of a whole table: with 5,000 finished meetings $read_few; with 20,000 $read_many)"
[ "${read_few%% *}" = "${read_many%% *}" ] || fail "a tick reads more with more finished meetings: $read_few, then $read_many"
[ "${read_many%% *}" -le 200 ] || fail "a tick reads more than it should, with nothing to do: $read_many"
[ "${read_many##* }" = "0" ] || fail "a tick scanned a whole table: $read_many"
echo "  ok: a tick reads the same rows with 20,000 finished meetings as with 5,000"
# The worst it can be: a full pool of each, every one of them looked at all the way down.
psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
              select gen_random_uuid(), 'x', 'indexing', 'a.mp4', 1, 'sweep_busy_' || g, 10 from generate_series(1, 2000) g;
            insert into public.pipeline_runs (meeting_id, stage, retry_at)
              select m.id, s.stage, now() + interval '1 hour' from public.meetings m,
                     (values ('transcription'), ('summarization'), ('search_index')) s(stage)
               where m.audio_key like 'sweep_busy_%';
            analyze public.meetings; analyze public.pipeline_runs;"
read_busy=$(rows_read)
echo "  (with 2,000 meetings in progress that cannot move as well: $read_busy)"
[ "${read_busy%% *}" -le 1000 ] || fail "a tick read more than the pool allows: $read_busy"
[ "${read_busy##* }" = "0" ] || fail "a tick scanned a whole table: $read_busy"
echo "  ok: a pool of meetings that cannot move costs a fixed number of rows too"
psql -q -c "delete from public.meetings where audio_key like 'sweep_read_%' or audio_key like 'sweep_busy_%';"

# Who may run it, and what it runs as.
for fn in 'public.sweep_next_meeting(text, uuid, text)' 'public.sweep_can_move(uuid, text, text, text, text, text[], timestamptz)'; do
  check "$fn is executable by service_role and not by PUBLIC, anon or authenticated" \
    "select has_function_privilege('service_role', '$fn', 'execute')
            and not has_function_privilege('anon', '$fn', 'execute')
            and not has_function_privilege('authenticated', '$fn', 'execute')
            and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                             where p.oid = '$fn'::regprocedure and a.grantee = 0)"
done
check "the sweeper's functions pin their search_path" \
  "select bool_and('search_path=public' = any(proconfig)) and count(*) = 2 from pg_proc
    where proname in ('sweep_next_meeting', 'sweep_can_move')"

# Repeatable: a second apply fails on nothing and loses no rotation.
mk "$SW1" uploaded
pick >/dev/null
psql -q < "$SWEEP_MIGRATION"
check "applying the sweeper's migration again keeps the rotation, and its posture" \
  "select last_meeting_id = '$SW1' and (select count(*) = 1 from public.sweep_state)
          and not has_function_privilege('anon', 'public.sweep_next_meeting(text, uuid, text)', 'execute')
          and has_function_privilege('service_role', 'public.sweep_next_meeting(text, uuid, text)', 'execute')
     from public.sweep_state"
gone "$SW1"

echo "checking the retention purge's selection (ADR-0017) ..."
PURGE_MIGRATION=supabase/migrations/20261103190000_retention_purge.sql
DEMO_ID=dddddddd-dddd-4ddd-8ddd-dddddddddddd
psql -q -c "delete from public.meetings;"
expired() { # expired [days]: the meeting that would be deleted next, or none
  psql -At -c "select coalesce(public.next_expired_meeting(${1:-30}, '$DEMO_ID')::text, 'none');"
}
expect_expired() { # expect_expired <description> <id or none> [days]
  local got
  got=$(expired "${3:-30}")
  [ "$got" = "$2" ] || fail "$1 (got '$got')"
  echo "  ok: $1"
}
day_old() { echo $(($1 * 86400)); }
expect_expired "nothing to delete answers null" none
mk "$SW1" ready null "$(day_old 29)"
expect_expired "a meeting inside its days stays" none
expect_expired "and goes with fewer days" "$SW1" 28
gone "$SW1"
mk "$SW1" ready null "$(day_old 31)"
expect_expired "a meeting past its days is the answer" "$SW1"
mk "$SW2" uploaded null "$(day_old 60)"
expect_expired "the oldest first, whatever its status" "$SW2"
psql -q -c "insert into public.pipeline_runs (meeting_id, stage, step_token, step_lease_until)
            values ('$SW2', 'transcription', gen_random_uuid(), now() + interval '1 minute');"
expect_expired "a live step keeps it, and the next is the answer" "$SW1"
psql -q -c "update public.pipeline_runs set step_lease_until = now() - interval '1 second' where meeting_id = '$SW2';"
expect_expired "a lease that has run out does not" "$SW2"
check "only the 20 oldest are looked at, so a read is bounded however many steps are live" \
  "select pg_get_functiondef('public.next_expired_meeting(integer, uuid)'::regprocedure) like '%limit 20%'"
gone "$SW2"
psql -q -c "update public.meetings set title = 'touched' where id = '$SW1';"
expect_expired "age is from created_at, however recently it was touched" "$SW1"
gone "$SW1"
mk "$DEMO_ID" ready null "$(day_old 400)"
expect_expired "the demo is never the answer, however old" none
check "and in capitals, which is the same row to Postgres" \
  "select public.next_expired_meeting(30, upper('$DEMO_ID')::uuid) is null"
gone "$DEMO_ID"
reject "no days has no safe reading" "select public.next_expired_meeting(null, '$DEMO_ID');" "positive whole number"
reject "zero days would make every meeting expired" "select public.next_expired_meeting(0, '$DEMO_ID');" "positive whole number"
reject "nor negative days" "select public.next_expired_meeting(-1, '$DEMO_ID');" "positive whole number"
reject "no demo would compare as nothing to leave out" "select public.next_expired_meeting(30, null);" "public demo must be named"
check "next_expired_meeting writes nothing, so a read-only caller could not make it delete" \
  "select provolatile = 's' from pg_proc where proname = 'next_expired_meeting'"
check "next_expired_meeting is executable by service_role and not by PUBLIC, anon or authenticated" \
  "select has_function_privilege('service_role', 'public.next_expired_meeting(integer, uuid)', 'execute')
          and not has_function_privilege('anon', 'public.next_expired_meeting(integer, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.next_expired_meeting(integer, uuid)', 'execute')
          and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                           where p.oid = 'public.next_expired_meeting(integer, uuid)'::regprocedure and a.grantee = 0)"
check "next_expired_meeting pins its search_path" \
  "select 'search_path=public' = any(proconfig) from pg_proc where proname = 'next_expired_meeting'"

# What it reads, by Postgres's own count, among as many old meetings as there are. Each with a
# run, as a real one has: on a nearly empty table a scan is the cheaper plan, and says nothing.
psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes,created_at)
              select gen_random_uuid(), 'x', 'ready', 'a.mp4', 1, 'purge_read_' || g, 10, now() - interval '400 days' - make_interval(secs => g)
                from generate_series(1, 20000) g;
            insert into public.pipeline_runs (meeting_id, stage)
              select id, 'search_index' from public.meetings where audio_key like 'purge_read_%';
            analyze public.meetings; analyze public.pipeline_runs;"
read_old=$(psql -q -At -c "begin;
    select count(*) from public.next_expired_meeting(30, '$DEMO_ID');
    select coalesce(sum(coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0)), 0) || ' ' || coalesce(sum(seq_scan), 0)
      from pg_stat_xact_user_tables where relname in ('meetings', 'pipeline_runs');
    rollback;" | tail -1)
echo "  (rows read to answer, then scans of a whole table, with 20,000 expired meetings: $read_old)"
# 20 meetings and a run each, at the very most. A plpgsql loop fetches ten at a time.
[ "${read_old%% *}" -le 40 ] || fail "choosing what to delete read too much, which a NOT EXISTS over the runs does: $read_old"
[ "${read_old##* }" = "0" ] || fail "choosing what to delete scanned a whole table: $read_old"
echo "  ok: choosing what to delete reads a fixed number of rows, however many have expired"
psql -q -c "delete from public.meetings where audio_key like 'purge_read_%';"

psql -q < "$PURGE_MIGRATION"
check "applying the purge's migration again keeps its posture" \
  "select not has_function_privilege('anon', 'public.next_expired_meeting(integer, uuid)', 'execute')
          and has_function_privilege('service_role', 'public.next_expired_meeting(integer, uuid)', 'execute')"

echo "checking the demo's question cap (ADR-0019) ..."
CAP_MIGRATION=supabase/migrations/20261104120000_demo_question_cap.sql
psql -q -c "delete from public.meetings; delete from public.demo_question_days;"
TODAY="(clock_timestamp() at time zone 'utc')::date"
take() { psql -q -At -c "select public.take_demo_question($1);"; }
gate() { psql -q -At -F ' ' -c "select over_count, extraction_pending from public.demo_question_gate($1, '$DEMO_ID');"; }
expect_gate() { # expect_gate <description> <limit> <'t f' as over_count extraction_pending>
  local got
  got=$(gate "$2")
  [ "$got" = "$3" ] || fail "$1 (got '$got', wanted '$3')"
  echo "  ok: $1"
}
expect_take() { # expect_take <description> <limit> <t or f>
  local got
  got=$(take "$2")
  [ "$got" = "$3" ] || fail "$1 (got '$got', wanted '$3')"
  echo "  ok: $1"
}
check "demo_question_days has RLS on and no policies" \
  "select c.relrowsecurity and not exists (select 1 from pg_policy where polrelid = c.oid)
   from pg_class c where c.oid = 'public.demo_question_days'::regclass"
expect_gate "the first question of a day is under its limit, with nothing pending" 2 "f f"
check "and reading it writes no row" "select count(*) = 0 from public.demo_question_days"
expect_take "a take within the limit is granted" 2 t
expect_take "and the next" 2 t
expect_gate "the gate reads the count reached" 2 "t f"
expect_take "a take past the limit is refused" 2 f
check "and counts nothing" "select taken = 2 from public.demo_question_days where day = $TODAY"
expect_gate "a higher limit has room again" 3 "f f"
expect_gate "a limit of zero is over from the first question" 0 "t f"
expect_take "and takes nothing" 0 f
expect_take "and nor does a negative one" -1 f
check "and neither touched the count" "select taken = 2 from public.demo_question_days where day = $TODAY"
reject "the gate has no safe reading of no limit" "select * from public.demo_question_gate(null, '$DEMO_ID');" "the limit must be given"
reject "the gate has no safe reading of no demo" "select * from public.demo_question_gate(5, null);" "public demo must be named"
reject "a take has no safe reading of no limit" "select public.take_demo_question(null);" "the limit must be given"
reject "a count below nothing is refused" "insert into public.demo_question_days (day, taken) values ('2000-01-01', -1);" "demo_question_days_taken_check"

psql -q -c "insert into public.demo_question_days (day, taken) values ($TODAY - 1, 99), ($TODAY - 40, 7);"
check "the gate reads only today" "select not over_count from public.demo_question_gate(3, '$DEMO_ID')"
check "reading deletes nothing of earlier days" "select count(*) = 3 from public.demo_question_days"
expect_take "a take still counts today" 3 t
check "and deletes the earlier days, so the table never grows" \
  "select count(*) = 1 and bool_and(day = $TODAY and taken = 3) from public.demo_question_days"
psql -q -c "insert into public.demo_question_days (day, taken) values ($TODAY - 1, 99);"
expect_take "a take refused over the limit" 3 f
check "still deletes earlier days" "select count(*) = 1 and bool_and(day = $TODAY) from public.demo_question_days"
psql -q -c "delete from public.demo_question_days;"

# Many at once, each its own session. A limit of 5 grants 5, which only the WHERE on the conflict can say.
for i in $(seq 1 20); do take 5 > "$TMPDIR_SWEEP/take_$i" & done
wait
granted=$(cat "$TMPDIR_SWEEP"/take_* | grep -c '^t$' || true)
[ "$granted" = "5" ] || fail "20 takes at once with a limit of 5 granted $granted"
echo "  ok: 20 takes at once with a limit of 5 grant exactly 5"
check "and the count says 5" "select taken = 5 from public.demo_question_days where day = $TODAY"
psql -q -c "delete from public.demo_question_days;"

# What counts as pending, each state its own row, and the same three states as extractionInProgress
# in shared/utils/meeting.ts, whose cases over real SQL are in tests/postgrest/demo-questions.spec.ts.
pending_state() { # pending_state <description> <status> <failed_stage or null> <t or f>
  mk "$SW1" "$2" "$3"
  expect_gate "$1" 5 "f $4"
  gone "$SW1"
}
pending_state "an upload that has not arrived is not pending" pending_upload null f
pending_state "an uploaded meeting is not pending" uploaded null f
pending_state "a meeting transcribing is not pending" transcribing null f
pending_state "a meeting summarizing is pending" summarizing null t
pending_state "a meeting indexing is pending" indexing null t
pending_state "a ready meeting is not pending" ready null f
pending_state "a failed upload is not pending" failed "'upload'" f
pending_state "a failed transcription is not pending" failed "'transcription'" f
pending_state "a failed extraction is pending" failed "'summarization'" t
mk "$DEMO_ID" failed "'summarization'"
expect_gate "the demo's own row does not count" 5 "f f"
check "and in capitals, which is the same row to Postgres" \
  "select not extraction_pending from public.demo_question_gate(5, upper('$DEMO_ID')::uuid)"
mk "$SW1" indexing
expect_gate "another meeting beside it does" 5 "f t"
gone "$SW1"
gone "$DEMO_ID"

check "the gate writes nothing, so a read-only caller could not make it take a question" \
  "select provolatile = 's' from pg_proc where proname = 'demo_question_gate'"
reject "and a read-only transaction cannot take one" \
  "begin read only; select public.take_demo_question(5); commit;" "read-only transaction"

# What the gate reads, by Postgres's own count, among as many finished meetings as there are,
# with the demo itself and another meeting in the states the index holds.
psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
              select gen_random_uuid(), 'x', 'ready', 'a.mp4', 1, 'cap_read_' || g, 10 from generate_series(1, 20000) g;
            analyze public.meetings;"
gate_reads() {
  psql -q -At -c "begin;
    select count(*) from public.demo_question_gate(5, '$DEMO_ID');
    select coalesce(sum(coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0)), 0) || ' ' || coalesce(sum(seq_scan), 0)
      from pg_stat_xact_user_tables where relname = 'meetings';
    rollback;" | tail -1
}
read_none=$(gate_reads)
echo "  (rows of meetings read to answer, then scans of a whole table, with 20,000 finished meetings: $read_none)"
[ "${read_none%% *}" -le 2 ] || fail "the gate read too many meetings: $read_none"
[ "${read_none##* }" = "0" ] || fail "the gate scanned the whole table: $read_none"
mk "$DEMO_ID" indexing
mk "$SW1" indexing
read_some=$(gate_reads)
echo "  (and with the demo and one other meeting in progress: $read_some)"
[ "${read_some%% *}" -le 2 ] || fail "the gate read too many meetings: $read_some"
[ "${read_some##* }" = "0" ] || fail "the gate scanned the whole table: $read_some"
echo "  ok: the gate reads at most the demo and one other row, however many meetings there are"
gone "$SW1"
gone "$DEMO_ID"
psql -q -c "delete from public.meetings where audio_key like 'cap_read_%';"

check "the cap's functions pin their search_path" \
  "select bool_and('search_path=public' = any(proconfig)) and count(*) = 2 from pg_proc
    where proname in ('demo_question_gate', 'take_demo_question')"
check_cap_posture() {
  for fn in 'public.demo_question_gate(integer, uuid)' 'public.take_demo_question(integer)'; do
    check "$1: $fn is executable by service_role and not by PUBLIC, anon or authenticated" \
      "select has_function_privilege('service_role', '$fn', 'execute')
              and not has_function_privilege('anon', '$fn', 'execute')
              and not has_function_privilege('authenticated', '$fn', 'execute')
              and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                               where p.oid = '$fn'::regprocedure and a.grantee = 0)"
  done
  check "$1: demo_question_days is for service_role and neither API role" \
    "select has_table_privilege('service_role', 'public.demo_question_days', 'select, insert, update, delete')
            and not has_table_privilege('anon', 'public.demo_question_days', 'select, insert, update, delete')
            and not has_table_privilege('authenticated', 'public.demo_question_days', 'select, insert, update, delete')"
}
check_cap_posture "as applied"

# Repeatable: a second apply fails on nothing, and keeps today's count.
expect_take "a question counted before applying again" 5 t
psql -q < "$CAP_MIGRATION"
check "applying the cap's migration again keeps the count" \
  "select count(*) = 1 and bool_and(taken = 1) from public.demo_question_days"
check_cap_posture "after a second apply"
psql -q -c "delete from public.demo_question_days;"

echo
echo "RESULT: PASS — $(ls supabase/migrations/*.sql | wc -l | tr -d ' ') migrations applied, all invariants hold"
