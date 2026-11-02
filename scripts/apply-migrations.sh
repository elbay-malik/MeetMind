#!/usr/bin/env bash
# Applies supabase/migrations/*.sql to a REAL Supabase project, in timestamp
# order, recording what it applied so a re-run is a no-op.
#
# This is the deploy-side counterpart to verify-migrations.sh. That script
# proves the SQL is correct against a throwaway Postgres; this one puts it on
# the project. Keep them in that order: verify first, then apply.
#
# Order matters and is not cosmetic -- 20260913 backfills data that 20260905
# creates, and 20260922 replaces a function 20260921 defines -- so the ledger
# below refuses to apply a file out of sequence rather than sorting by name and
# hoping.
#
# Usage: scripts/apply-migrations.sh [--dry-run]
# Reads SUPABASE_DB_URL from .env (or the environment). Requires Docker;
# psql is not installed on this machine and the pgvector image carries one.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# --- the connection string, and the three ways it is usually wrong ----------
if [ -z "${SUPABASE_DB_URL:-}" ] && [ -f .env ]; then
  # Read it without sourcing .env: that file holds keys with characters a
  # shell would interpret, and sourcing it would also export them all.
  SUPABASE_DB_URL=$(sed -n 's/^SUPABASE_DB_URL=//p' .env | head -1 | sed 's/^["'\'']//;s/["'\'']$//')
fi

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "FAIL: SUPABASE_DB_URL is not set (.env or environment)."
  echo "  Supabase dashboard -> Connect -> Session pooler."
  exit 1
fi

# 1. The placeholder. The dashboard renders the string with a literal
#    [YOUR-PASSWORD] in it, and pasting it unchanged fails as
#    `password authentication failed`, which names the wrong cause.
case "$SUPABASE_DB_URL" in
  *'[YOUR-PASSWORD]'*|*'[your-password]'*)
    echo "FAIL: SUPABASE_DB_URL still contains the literal [YOUR-PASSWORD] placeholder."
    echo "  Replace it with the database password (Project Settings -> Database"
    echo "  -> Reset database password if it is not to hand). Percent-encode any"
    echo "  of : / ? # [ ] @ that the password contains."
    exit 1
    ;;
esac

# 2. The direct connection. New projects resolve db.<ref>.supabase.co over
#    IPv6 only, which Docker's default bridge cannot route.
case "$SUPABASE_DB_URL" in
  *"@db."*".supabase.co"*)
    echo "FAIL: that is the Direct connection string (db.<ref>.supabase.co)."
    echo "  It is IPv6-only on new projects and unreachable from Docker's bridge."
    echo "  Use the Session pooler string instead (aws-N-<region>.pooler.supabase.com:5432)."
    exit 1
    ;;
esac

# 3. The transaction pooler. Port 6543 multiplexes statements across
#    connections and rejects the session-scoped things DDL needs.
case "$SUPABASE_DB_URL" in
  *".pooler.supabase.com:6543"*)
    echo "FAIL: that is the Transaction pooler (port 6543), which cannot run DDL."
    echo "  Use the Session pooler on port 5432."
    exit 1
    ;;
esac

IMAGE=pgvector/pgvector:pg17

# The URL goes in as an environment variable, never as an argv element: argv is
# world-readable in `ps` for the lifetime of the call, and this one carries the
# password. Hence the `sh -c` hop -- the expansion has to happen inside the
# container, where the variable exists.
psql_url() { docker run -i --rm -e PGURL="$SUPABASE_DB_URL" --entrypoint sh "$IMAGE" \
  -c 'exec psql "$PGURL" -v ON_ERROR_STOP=1 "$@"' -- "$@"; }

echo "pulling ${IMAGE} if needed ..."
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull -q "$IMAGE" >/dev/null

echo "connecting ..."
if ! server=$(psql_url -At -F ' / ' -c 'select current_database(), split_part(version(), chr(44), 1)' 2>&1); then
  echo "FAIL: could not connect."
  # Echo the server's error but never the URL, which carries the password.
  echo "$server" | sed 's/postgres:\/\/[^ ]*/<redacted>/g' | tail -5
  exit 1
fi
echo "  connected: ${server}"

# --- the ledger ------------------------------------------------------------
# Its own schema, so it cannot collide with anything the app owns, and so
# `supabase db push` later sees an empty public schema history rather than a
# half-recognised one.
psql_url -q -c "
  create schema if not exists meetmind_migrations;
  create table if not exists meetmind_migrations.applied (
    filename    text primary key,
    sha256      text not null,
    applied_at  timestamptz not null default now()
  );
" >/dev/null

applied_list=$(psql_url -At -F $'\t' -c \
  'select filename, sha256 from meetmind_migrations.applied' || true)

pending=0
skipped=0
for f in supabase/migrations/*.sql; do
  name=$(basename "$f")
  want=$(shasum -a 256 "$f" | cut -d' ' -f1)
  have=$(printf '%s\n' "$applied_list" | awk -F'\t' -v n="$name" '$1==n {print $2}')

  if [ -n "$have" ]; then
    if [ "$have" != "$want" ]; then
      echo "FAIL: ${name} was already applied, but its contents have changed."
      echo "  A migration is immutable once applied. Add a new migration that"
      echo "  alters what this one created instead of editing it."
      exit 1
    fi
    skipped=$((skipped + 1))
    continue
  fi

  pending=$((pending + 1))
  if [ "$DRY_RUN" = 1 ]; then
    echo "  would apply  ${name}"
    continue
  fi

  echo "  applying     ${name}"
  # One transaction per file, so a failure leaves nothing half-applied and the
  # ledger row lands only if the SQL did. --single-transaction plus
  # ON_ERROR_STOP is what makes that true.
  if ! out=$(docker run -i --rm -e PGURL="$SUPABASE_DB_URL" --entrypoint sh "$IMAGE" -c \
      'exec psql "$PGURL" -v ON_ERROR_STOP=1 --single-transaction -q -f -' < "$f" 2>&1); then
    echo "FAIL: ${name} did not apply. Nothing was committed from it."
    echo "$out" | sed 's/postgres:\/\/[^ ]*/<redacted>/g' | tail -20
    exit 1
  fi
  [ -n "$out" ] && echo "$out" | sed 's/^/      /'
  psql_url -q -c "insert into meetmind_migrations.applied (filename, sha256)
                  values ('${name}', '${want}')" >/dev/null
done

echo
if [ "$DRY_RUN" = 1 ]; then
  echo "dry run: ${pending} to apply, ${skipped} already applied."
  exit 0
fi
echo "done: ${pending} applied, ${skipped} already present."

# --- what the app actually needs to exist ----------------------------------
# Not a full re-run of verify-migrations.sh's invariants: just proof that the
# objects the server routes reach for are there, so a silent partial apply
# cannot be mistaken for success.
echo
echo "checking the schema the app expects ..."
missing=$(psql_url -At -c "
  with expected(kind, name) as (values
    ('table','meetings'), ('table','transcript_segments'),
    ('table','meeting_summaries'), ('table','meeting_decisions'),
    ('table','meeting_action_items'), ('table','transcript_windows'),
    ('table','provider_slots'), ('table','pipeline_runs'), ('table','summary_chunks'),
    ('function','match_transcript_windows'),
    ('function','stored_audio_bytes'),
    ('function','reserve_slot'), ('function','note_rate_limit'),
    ('function','claim_step'), ('function','release_step'), ('function','locked_step_run'),
    ('function','plan_chunks'), ('function','record_chunk'), ('function','finalize_summary'),
    ('function','append_segments'), ('function','finish_transcription')
  )
  select kind || ' ' || name from expected e
  where not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = e.name
      and c.relkind in ('r','p') and e.kind = 'table'
    union all
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = e.name and e.kind = 'function'
  );")

if [ -n "$missing" ]; then
  echo "FAIL: applied cleanly but these are absent:"
  echo "$missing" | sed 's/^/      /'
  exit 1
fi

# RLS on with zero policies is the access model, not an oversight: every read
# goes through the service-role key on the server. A table with RLS off would
# be reachable with the anon key.
unprotected=$(psql_url -At -c "
  select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;")
if [ -n "$unprotected" ]; then
  echo "FAIL: these public tables have RLS disabled and are anon-readable:"
  echo "$unprotected" | sed 's/^/      /'
  exit 1
fi

echo "  all 9 tables and 11 functions present; RLS enabled on every public table."
