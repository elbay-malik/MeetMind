#!/usr/bin/env bash
# Runs the whole of .github/workflows/ci.yml on this machine, so a PR can be
# judged green without waiting on GitHub.
#
# The one property that matters: GREEN HERE MEANS GREEN THERE. A job this
# script cannot run is a FAILURE, not a skip — "verification that passes while
# doing nothing" is this repo's most expensive recurring bug (a NUL byte that
# hid a file from five review rounds; a `| tee` that swallowed a driver's exit
# code for two phases). Use --skip to leave a job out deliberately; the verdict
# then says INCOMPLETE and names what was left out.
#
# Usage:
#   pnpm ci:local                      every job, in ci.yml's order
#   pnpm ci:local --only browser       just one (comma-separated for several)
#   pnpm ci:local --skip migrations    everything except one
#   pnpm ci:local --fail-fast          stop at the first failing job
#   pnpm ci:local --list               print the jobs and what each runs
#
# Jobs run SEQUENTIALLY, unlike CI's parallel matrix: `nuxt typecheck`, `pnpm
# test:e2e` and `pnpm build` all write .nuxt/ and .output/, so running them
# concurrently makes them fight over the same directories. A trustworthy five
# minutes beats a flaky two.
set -euo pipefail
cd "$(dirname "$0")/.."

JOBS=(lint typecheck test audit e2e migrations browser)
LOG_DIR=.data/ci-local
PORT_BASE=3000

# Mirrors ci.yml's `run:` step for each single-command job. Kept as literal
# strings because tests/unit/ci-local-parity.spec.ts reads BOTH this and
# ci.yml and fails when they drift — the same "hold the copy to the original"
# trick scripts/lib/citation-match.mjs and verify-migrations.sh already use,
# because a hand-synced duplicate of CI is just a new place for CI to be wrong.
job_command() {
  case "$1" in
    lint)       echo 'pnpm lint' ;;
    typecheck)  echo 'pnpm typecheck' ;;
    test)       echo 'pnpm test' ;;
    audit)      echo 'pnpm audit --prod --audit-level=high' ;;
    e2e)        echo 'pnpm test:e2e' ;;
    migrations) echo 'bash scripts/verify-migrations.sh' ;;
    browser)    echo '(multi-step: make-fixture.sh, pnpm build, drive-upload.mjs, drive-player.mjs)' ;;
  esac
}

ONLY=""; SKIP=""; FAIL_FAST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --skip) SKIP="$2"; shift 2 ;;
    --fail-fast) FAIL_FAST=1; shift ;;
    --list)
      for j in "${JOBS[@]}"; do printf '  %-11s %s\n' "$j" "$(job_command "$j")"; done
      exit 0 ;;
    # Prints the header comment and stops at the first line that is not one,
    # so adding to the comment never needs a line number updated here.
    -h|--help) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

in_list() { # in_list <needle> <comma-list>
  [ -n "$2" ] && printf '%s' ",$2," | grep -q ",$1,"
}
selected() {
  if [ -n "$ONLY" ]; then in_list "$1" "$ONLY"; return; fi
  ! in_list "$1" "$SKIP"
}

mkdir -p "$LOG_DIR"
# Cleanup state goes in FILES, not shell variables, because each job runs
# inside a pipeline (see the run loop) and so in a subshell — a variable set
# there would never reach this trap, leaving a server process and a temp dir
# behind on every failure.
PID_FILE="$LOG_DIR/server.pid"
DATA_DIR_FILE="$LOG_DIR/browser-data-dir"
cleanup() {
  [ -f "$PID_FILE" ] && { kill "$(cat "$PID_FILE")" 2>/dev/null || true; rm -f "$PID_FILE"; }
  [ -f "$DATA_DIR_FILE" ] && { rm -rf "$(cat "$DATA_DIR_FILE")" || true; rm -f "$DATA_DIR_FILE"; }
  return 0
}
trap cleanup EXIT INT TERM

declare -a RESULTS=()
FAILED=0
SKIPPED_ON_PURPOSE=()

# Colour only on a terminal: these logs get piped and pasted into PRs.
if [ -t 1 ]; then
  C_DIM=$'\033[2m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_OFF=$'\033[0m'
else
  C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_OFF=""
fi
note() { printf '%s%s%s\n' "$C_DIM" "$1" "$C_OFF"; }
record() { RESULTS+=("$1|$2|$3"); }

# --- preflight ---------------------------------------------------------------
# CI gets a clean checkout and runs `pnpm install --frozen-lockfile` in every
# job. Doing that for every job here would be pointless, but skipping it entirely
# would miss the one thing it actually catches: a lockfile that no longer
# matches package.json. So: install only when the lockfile is newer than the
# installed tree, which is exactly that case.
if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
  echo "▸ pnpm install --frozen-lockfile (lockfile newer than node_modules)"
  pnpm install --frozen-lockfile
else
  note "  dependencies look current; skipping the per-job pnpm install CI does"
fi

require() { # require <job> <what> <test-cmd> <how-to-fix>
  if ! eval "$3" >/dev/null 2>&1; then
    echo "✗ $1 cannot run: $2 is unavailable" >&2
    echo "  fix: $4" >&2
    echo "  or:  pnpm ci:local --skip $1   (the verdict will then say INCOMPLETE)" >&2
    return 1
  fi
}

# --- the browser job ---------------------------------------------------------
# ci.yml's own block, with three deliberate differences, each because the local
# machine is not a fresh Ubuntu runner:
#   - apt-get ffmpeg and `playwright-core install --with-deps` are checks here,
#     not installs: --with-deps needs sudo, and silently apt-getting on a dev
#     machine is rude.
#   - the port is chosen rather than hardcoded to 3000, because `pnpm dev` is
#     usually already sitting on it. The drivers all take the base URL as an
#     argument, so nothing about the test changes.
# Everything that actually VERIFIES anything is run exactly as CI runs it,
# including `set -o pipefail` semantics for the piped driver — CI needed an
# explicit `shell: bash` for that and got it wrong for two phases.
#
# Every step that can fail says `|| return 1`, because `set -e` does nothing here:
# run_job runs as an `if` condition, where bash ignores it all the way down. Without
# these the job's status was cleanup's, so a failing driver reported a pass.
run_browser_job() {
  require browser ffmpeg 'command -v ffmpeg' 'brew install ffmpeg' || return 1

  if [ ! -f fixtures/fixture-30s-720p.mp4 ]; then
    echo "  generating the test fixture (not committed)"
    bash scripts/make-fixture.sh || return 1
  fi

  if ! pnpm exec playwright-core install --dry-run chromium >/dev/null 2>&1; then
    note "  could not confirm Chromium; installing it for playwright-core"
    pnpm exec playwright-core install chromium || return 1
  fi

  pnpm build || return 1

  local port=$PORT_BASE
  while lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    port=$((port + 1))
  done
  [ "$port" = "$PORT_BASE" ] || note "  port $PORT_BASE is busy; using $port instead"
  local base="http://localhost:$port"

  # For the server and the driver. Throwaway, like the upload secret below: this
  # server lives for one job. Exported inside the job's own subshell, so it ends here.
  export NUXT_INVITE_CODE=ci-invite-code-0123456789abcdefghij

  local data_dir
  data_dir=$(mktemp -d)
  printf '%s' "$data_dir" > "$DATA_DIR_FILE"
  # NUXT_ALLOW_LOCAL_DRIVERS: a real production build, which refuses local drivers
  # unless told otherwise (ADR-0016).
  NUXT_ALLOW_LOCAL_DRIVERS=true NUXT_DATA_DIR="$data_dir" NUXT_UPLOAD_TOKEN_SECRET=ci-secret PORT="$port" \
    node .output/server/index.mjs > "$LOG_DIR/server.log" 2>&1 &
  printf '%s' "$!" > "$PID_FILE"

  local up=0
  for _ in $(seq 1 60); do
    curl -sf "$base/api/health" >/dev/null && { up=1; break; }
    sleep 1
  done
  [ "$up" = 1 ] || { echo "  server never became healthy; see $LOG_DIR/server.log" >&2; return 1; }

  # pipefail is on (set -o pipefail at the top of this file), so the driver's
  # own exit code survives the pipe. This is the exact bug ci.yml had.
  node scripts/drive-upload.mjs "$base" fixtures/fixture-30s-720p.mp4 "$data_dir" \
    | tee "$LOG_DIR/upload.log" || return 1
  local meeting_id
  meeting_id=$(grep -oE 'landed on progress page for [0-9a-f-]{36}' "$LOG_DIR/upload.log" | awk '{print $NF}')
  [ -n "$meeting_id" ] || { echo "  no meeting id in upload output" >&2; return 1; }

  node scripts/drive-player.mjs "$base" "$meeting_id" || return 1

  cleanup
}

run_job() {
  case "$1" in
    migrations)
      require migrations Docker 'docker info' 'open -a OrbStack, then wait for it to start' || return 1
      bash scripts/verify-migrations.sh ;;
    browser) run_browser_job ;;
    *) eval "$(job_command "$1")" ;;
  esac
}

# --- run ---------------------------------------------------------------------
echo
for job in "${JOBS[@]}"; do
  if ! selected "$job"; then
    note "— $job not selected ($([ -n "$ONLY" ] && echo "--only $ONLY" || echo "--skip $SKIP"))"
    SKIPPED_ON_PURPOSE+=("$job")
    record "$job" skipped 0
    continue
  fi

  echo "▸ $job"
  started=$SECONDS
  # A plain pipeline, NOT `> >(...)` process substitution: that is
  # asynchronous, so the tee/sed subshell was still flushing when the parent
  # printed the next job's heading — output arrived out of order and a job's
  # own result line went missing. pipefail carries run_job's status through.
  if run_job "$job" 2>&1 | tee "$LOG_DIR/$job.log" | sed 's/^/    /'; then
    took=$((SECONDS - started))
    printf '%s✓ %s%s (%ss)\n\n' "$C_GREEN" "$job" "$C_OFF" "$took"
    record "$job" pass "$took"
  else
    took=$((SECONDS - started))
    printf '%s✗ %s%s (%ss) — see %s/%s.log\n\n' "$C_RED" "$job" "$C_OFF" "$took" "$LOG_DIR" "$job"
    record "$job" fail "$took"
    FAILED=$((FAILED + 1))
    [ "$FAIL_FAST" = 1 ] && break
  fi
done

# --- verdict -----------------------------------------------------------------
echo "────────────────────────────────────────"
for r in "${RESULTS[@]}"; do
  IFS='|' read -r name status took <<< "$r"
  case "$status" in
    pass) printf '  %s%-11s pass%s  %ss\n' "$C_GREEN" "$name" "$C_OFF" "$took" ;;
    fail) printf '  %s%-11s FAIL%s  %ss\n' "$C_RED" "$name" "$C_OFF" "$took" ;;
    *)    printf '  %s%-11s skipped%s\n' "$C_DIM" "$name" "$C_OFF" ;;
  esac
done
echo "────────────────────────────────────────"

if [ "$FAILED" -gt 0 ]; then
  printf '%sRESULT: FAIL — %s job(s)%s\n' "$C_RED" "$FAILED" "$C_OFF"
  exit 1
fi
if [ "${#SKIPPED_ON_PURPOSE[@]}" -gt 0 ]; then
  printf '%sRESULT: INCOMPLETE — passed, but did not run: %s%s\n' "$C_YELLOW" "${SKIPPED_ON_PURPOSE[*]}" "$C_OFF"
  printf 'This is NOT the same as a green CI run.\n'
  exit 0
fi
printf '%sRESULT: PASS — every CI job green locally%s\n' "$C_GREEN" "$C_OFF"
