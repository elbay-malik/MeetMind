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

# Applied with a stored window and indexes on the old column in place, to prove it
# clears what a cast could not convert rather than only working on an empty table.
EMBEDDING_MIGRATION=supabase/migrations/20261102120000_workers_ai_embeddings.sql

prepare_legacy_windows() {
  # Supabase has these roles and a plain Postgres does not, so without them the
  # migration's revokes and its grant to service_role never run here.
  psql -q -c "create role anon nologin; create role authenticated nologin; create role service_role nologin;"
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

check "the ledger functions pin their search_path" \
  "select bool_and('search_path=public' = any(proconfig)) and count(*) = 8 from pg_proc
   where proname in ('claim_step', 'release_step', 'locked_step_run', 'plan_chunks', 'record_chunk', 'finalize_summary',
                     'append_segments', 'finish_transcription')"
psql -q -c "delete from public.meetings where id in ('$L1', '$L2', '$L3', '$L4');"
check "deleting a meeting removes its runs and chunks" \
  "select not exists (select 1 from public.pipeline_runs where meeting_id in ('$L1', '$L3', '$L4'))
          and not exists (select 1 from public.summary_chunks where meeting_id in ('$L3', '$L4'))"
psql -q -c "drop table vl_c; drop table vl_m;"

echo
echo "RESULT: PASS — $(ls supabase/migrations/*.sql | wc -l | tr -d ' ') migrations applied, all invariants hold"
