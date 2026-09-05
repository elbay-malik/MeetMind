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

for f in supabase/migrations/*.sql; do
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

check "audio cap matches MAX_AUDIO_BYTES in shared/utils/meeting.ts" \
  "select pg_get_constraintdef(con.oid) like '%25000000%'
   from pg_constraint con join pg_class rel on rel.oid=con.conrelid
   where rel.relname='meetings' and con.contype='c'
     and pg_get_constraintdef(con.oid) like '%audio_bytes%'"

check "row-level security is on with no policies" \
  "select relrowsecurity and (select count(*) from pg_policies where tablename='meetings')=0
   from pg_class where relname='meetings'"

# Every status in the TypeScript union must be insertable.
psql -q -c "do \$\$
declare s text;
begin
  foreach s in array array['pending_upload','uploaded','transcribing','summarizing','indexing','ready','failed'] loop
    insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
    values (gen_random_uuid(), s, s, 'a.mp4', 1, 'lifecycle_'||s, 10);
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

# updated_at must advance on update. now() is transaction-scoped, so the insert
# and the update have to happen in separate transactions or this always passes.
psql -q -c "insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes)
            values ('22222222-2222-2222-2222-222222222222','t','pending_upload','a.mp4',1,'trigger_probe',10);"
psql -q -c "update public.meetings set updated_at='2000-01-01' where id='22222222-2222-2222-2222-222222222222';"
check "updated_at trigger overrides whatever the client sends" \
  "select updated_at > created_at from public.meetings where id='22222222-2222-2222-2222-222222222222'"

echo
echo "RESULT: PASS — $(ls supabase/migrations/*.sql | wc -l | tr -d ' ') migrations applied, all invariants hold"
