# MeetMind

**Meeting videos in. Searchable, timestamped knowledge out. No raw video ever leaves your browser.**

MeetMind turns recorded meetings into timestamped transcripts, structured summaries
(decisions and action items with assignees), and semantic Q&A over each meeting — while keeping
the entire video on the user's machine. Audio is extracted and compressed **in the
browser** with ffmpeg.wasm; only ~7-11 MB of 16 kHz mono Opus per meeting hour is ever
uploaded. The whole stack runs on free tiers (target: 0 EUR/month).

> Status: early development. Currently built: repo scaffold, five-screen skeleton, the
> ffmpeg.wasm audio-extraction spike ([ADR-0002](docs/adr/0002-ffmpeg-spike-results.md)),
> in-browser audio extraction on the home screen, upload & storage
> ([ADR-0003](docs/adr/0003-upload-and-storage.md)): the compressed audio goes straight
> from the browser to Cloudflare R2 via a presigned URL, the meeting row to Supabase
> Postgres — and transcription ([ADR-0004](docs/adr/0004-transcription.md)) via Groq
> Whisper, with local drivers and a stub transcriber so dev and CI need no credentials.

## Architecture

```
┌────────────────────────── Browser ──────────────────────────┐
│ video file ─► ffmpeg.wasm (Web Worker, single-thread)       │
│              -vn, 16 kHz mono Opus @16 kbps (~7 MB/hour)    │
└───────────────┬──────────────────────────────────────────────┘
                │ compressed audio only (<25 MB), PUT to a
                │ presigned URL ─► Cloudflare R2 (audio blobs)
                ▼
┌─────────────── Nitro server routes (secrets live here) ─────┐
│ register meeting ─► Supabase Postgres row; verify upload    │
│ Groq Whisper Large v3 Turbo ─► timestamped transcript       │
│   (one request per meeting; segments in integer ms)         │
│ Groq gpt-oss ─► decisions & action items, each citing a     │
│   transcript segment that is verified before storage        │
│ Workers AI bge-m3 (1024d) ─► Supabase pgvector; questions   │
│   answered by gpt-oss, citations verified like summaries    │
└───────────────┬──────────────────────────────────────────────┘
                ▼
   Transcript ↔ player over a byte-range route (click-to-seek both ways),
   semantic Q&A with clickable timestamp citations, each meeting reachable
   only through its own unguessable link
```

The full phased build plan lives in [docs/PLAYBOOK.md](docs/PLAYBOOK.md).

## Who can see a meeting

MeetMind is a portfolio demo with no accounts, so **a meeting's link is the only key to
it**. The link holds a random UUID, and nothing on the server lists meetings or searches
across them. "Your meetings" is a list kept only in the browser that uploaded them, so
losing the link loses access, and anyone given the link can read the meeting. A leaked
link can only be revoked by an operator deleting the meeting. Nothing deletes a meeting by
itself, unless someone turns on the optional purge in
[ADR-0017](docs/adr/0017-retention-purge.md), and then the upload page says so. Do not upload anything
sensitive: audio goes to Groq and is stored at Cloudflare, transcripts and questions go to
Groq and Cloudflare. See [ADR-0013](docs/adr/0013-private-meeting-links.md), including its
limits.

## Who can upload

Public visitors get the demo meeting, and **uploading takes an invite code**. Set
`NUXT_INVITE_CODE` to at least 32 characters (`openssl rand -hex 24`) and give it to whoever
may upload; it is sent in a request header and kept only in the page's memory. Leaving it out
never selects a stub, even under `pnpm dev`: **unset or too short, uploads are closed
for everyone**. It is one shared code, so rotating it locks everyone out of uploading, and
existing links keep working.

Set `NUXT_PUBLIC_DEMO_MEETING_ID` to link one finished meeting from the home page. Anyone can
read that meeting and ask it questions, which spends the shared quotas, and nobody can change
it through its link. Its audio expires with the bucket's lifecycle rule (below) like any other,
so it has to be put back every 30 days or the player stops working. To create it, see "Creating
the demo meeting" in [ADR-0015](docs/adr/0015-invite-only-uploads.md), which also records what guards every route
that can write, and what this does not do.

## Architecture Decision Records

| ADR | Decision |
| --- | --- |
| [0001](docs/adr/0001-client-side-audio-extraction.md) | Client-side audio extraction: single-thread ffmpeg.wasm, Opus 16 kHz mono |
| [0002](docs/adr/0002-ffmpeg-spike-results.md) | FFmpeg WASM spike results (measured numbers) |
| [0003](docs/adr/0003-upload-and-storage.md) | Upload & storage: direct-to-R2 presigned PUT, Supabase Postgres metadata, local drivers for dev/CI |
| [0004](docs/adr/0004-transcription.md) | Transcription: one request per meeting, no chunking, stub provider for credential-free dev |
| [0005](docs/adr/0005-audio-playback-and-transcript-sync.md) | Playback: same-origin byte-range route, native player before a waveform |
| [0006](docs/adr/0006-structured-summaries.md) | Summaries: chunked extraction, citations checked against the transcript |
| [0007](docs/adr/0007-semantic-qa.md) | Semantic Q&A: windowed embeddings, answers held to the same citation check. Its choice of provider is superseded by ADR-0014 |
| [0008](docs/adr/0008-cross-meeting-search.md) | Cross-meeting search: passages across meetings, not a synthesized answer; still no HNSW. Superseded by ADR-0013 |
| [0009](docs/adr/0009-workers-measurement-spike.md) | Workers measurement spike before Phase 9: what the runtime actually does, measured rather than inferred |
| [0010](docs/adr/0010-r2-cost-controls.md) | R2 cost controls: a lifecycle rule bounds growth, an application storage budget is the hard stop, per-request op metering rejected |
| [0011](docs/adr/0011-admin-meeting-delete.md) | Deleting a meeting is admin-only, behind `NUXT_ADMIN_TOKEN`; refused while anything could still write its data |
| [0012](docs/adr/0012-pipeline-orchestration.md) | Pipeline orchestration on the Workers free plan: one bounded step per request, driven by the open page with no click and one driving tab per browser, Postgres rate-limit slots, polling not SSE, and a cron that moves a closed tab's meeting very slowly |
| [0013](docs/adr/0013-private-meeting-links.md) | A meeting is reached only through its unguessable link: no global list or cross-meeting search, \"Your meetings\" lives in this browser |
| [0014](docs/adr/0014-workers-ai-embeddings.md) | Embeddings from Cloudflare Workers AI's bge-m3 at 1024 dimensions, replacing a provider whose terms require a paid plan in the EEA: measured batch limits, and a plain message at the daily limit |
| [0015](docs/adr/0015-invite-only-uploads.md) | Visitors get the demo meeting, which can only be read and asked; uploading takes an invite code, and a missing code closes it. A guard for every route that can write |
| [0016](docs/adr/0016-real-services-or-nothing.md) | A deployment runs on the real services or answers 503: stubs and local stores need an explicit opt-in, and are refused beside real stored data and on a Worker |
| [0017](docs/adr/0017-retention-purge.md) | An optional purge deletes a meeting past its retention days, one per cron tick, never the demo or anything a step is live on. Off until someone turns it on |

New decisions follow the [ADR template](docs/adr/0000-template.md).

## Project structure

```
app/            Nuxt 4 app: pages (5 core screens), layouts, components, composables
app/workers/    Web Worker sources (ffmpeg orchestration) — not auto-imported
server/api/     Nitro routes — the only place secrets are read
server/utils/   Storage drivers (R2 | local fs) and meeting repositories (Supabase | local JSON)
shared/         Isomorphic code: `utils/` + `types/` (auto-imported), `schemas/` (zod, explicit import)
supabase/       SQL migrations for the Postgres schema
public/ffmpeg/  Self-hosted ffmpeg.wasm core assets (copied on postinstall, gitignored)
scripts/        Fixture generation and headless-browser drivers (spike, upload flow)
docs/           Playbook + ADRs
tests/          Vitest: `unit/`, Nuxt-runtime `nuxt/`, and server-route `e2e/` (built app)
.data/          Local drivers' audio + meeting rows (gitignored; only without R2/Supabase)
```

## Setup

Requires Node 24 (pinned in `.node-version`; [fnm](https://github.com/Schniz/fnm) picks it
up automatically) and pnpm via corepack:

```bash
corepack enable
pnpm install        # also copies ffmpeg core assets into public/ffmpeg/
cp .env.example .env  # then set NUXT_INVITE_CODE, and any cloud credentials (see below)
pnpm dev            # http://localhost:3000
```

Under `pnpm dev`, without any credentials, the app is fully usable: uploaded audio and
meeting rows are kept under `.data/` by the local drivers, and stubs stand in for Groq and
Workers AI. The one setting you need even so is `NUXT_INVITE_CODE`, since without it uploading
is closed (see [Who can upload](#who-can-upload)). Set the variables below to switch to the
production services. Groq and Workers AI can each be switched alone, while the stores are
local. Supabase and R2 go together, and with either of them everything has to be real (see
[What a deployment needs](#what-a-deployment-needs)).

Once real keys are in place, `pnpm test:services` checks each one against the driver
that uses it — presigned uploads and CORS on R2, the schema and triggers on Supabase,
whether Groq's response really has the shape the parser assumes, and that Workers AI
returns 1024-dimension vectors, refuses an input over its limit rather than cutting it,
and ranks the right passage first for a reworded question in English and in German.
Those contracts are the one thing the offline tests cannot prove.

### What a deployment needs

A built server has no stand-ins. It needs `NUXT_GROQ_API_KEY`, `NUXT_WORKERS_AI_ACCOUNT_ID`,
`NUXT_WORKERS_AI_API_TOKEN`, `NUXT_SUPABASE_URL`, `NUXT_SUPABASE_SERVICE_KEY`,
`NUXT_R2_ACCOUNT_ID`, `NUXT_R2_ACCESS_KEY_ID`, `NUXT_R2_SECRET_ACCESS_KEY` and `NUXT_R2_BUCKET`.
With any of them missing, every route that needs a provider or store answers 503 with one message
that names nothing, before anything is claimed, called or written, and the server log names
what is missing, never a value. The home page and `/api/health` still answer, and a meeting's page
shows a plain failure. [ADR-0016](docs/adr/0016-real-services-or-nothing.md) has the reasons.

| Running | Every setting present | Some missing, stores local | A real database or bucket, something else missing | Half of a group |
| --- | --- | --- | --- | --- |
| A Cloudflare Worker | Real services | **503** | **503** | **503** |
| A built server | Real services | **503** | **503** | **503** |
| A built server with `NUXT_ALLOW_LOCAL_DRIVERS=true` | Real services | Stand-ins for what is missing | **503** | **503** |
| `pnpm dev` | Real services | Stand-ins for what is missing | **503** | **503** |

`NUXT_ALLOW_LOCAL_DRIVERS=true` is for the e2e and browser jobs, which run a production build
on local drivers. A deployment does not set it: a Worker ignores it outright, and so does
any server beside a real database. It does not belong in `wrangler.jsonc`, or in a real `.env`.
`node .output/server/index.mjs` reads no dotenv file, so without the opt-in it refuses unless the
environment holds all nine settings. `pnpm preview` is different, because `nuxt preview` loads `.env`
into the server it starts: with a full `.env` it runs on the real services, as `pnpm dev` does, so an
upload through it writes real data and spends quota. An opt-in in that `.env` opens it too.

### Storage setup (Cloudflare R2)

1. Create an R2 bucket.
2. Add a CORS policy to the bucket, so the browser may PUT to presigned URLs.
   Without it uploads fail **only in a real browser** — never in the tests.

   ```bash
   npx wrangler r2 bucket cors set <bucket> --file infra/r2-cors.json
   ```

   Add the deployed origin to `infra/r2-cors.json` when there is one. Note the
   dashboard (bucket → Settings → CORS Policy) takes a *different*, S3-style
   shape for the same policy — `[{"AllowedOrigins": [...], "AllowedMethods":
   [...]}]` — and wrangler rejects it. Each tool is right for itself; the
   committed file is the wrangler one.

3. Bound the cost. R2 has **no spending cap** — overage is billed, and the only
   usage notification needs a Professional plan — so the limits have to be built:

   ```bash
   # Expire audio so storage cannot grow without bound. Scoped to the app's keys.
   npx wrangler r2 bucket lifecycle add <bucket> expire-meeting-audio-30d meetings/ --expire-days 30
   ```

   Do **not** add a bucket lock: it blocks the rule above and makes the bucket
   impossible to empty. Note a lifecycle rule bounds slow growth only — it does
   nothing against a burst.

   The hard stop is server-side: `POST /api/meetings` answers **507** once the
   stored bytes plus the incoming upload would cross `NUXT_R2_MAX_STORED_BYTES`
   (default 8 GiB). Set `NUXT_R2_RETENTION_DAYS` to the **same number of days as
   the lifecycle rule** — it is how the byte estimate knows which uploads
   Cloudflare has already deleted, and nothing in the app can verify the two
   agree. See [ADR-0010](docs/adr/0010-r2-cost-controls.md).

   Space is reclaimed by deleting meetings, which is an operator task. Set
   `NUXT_ADMIN_TOKEN` (at least 32 characters, e.g. `openssl rand -base64 32`),
   then:

   ```bash
   curl -X DELETE -H "Authorization: Bearer $NUXT_ADMIN_TOKEN" \
     https://<host>/api/meetings/<id>
   ```

   That removes the audio, transcript, summary and search index, and the bytes
   stop counting against the ceiling at once. Without the token the route
   answers 404. It answers 409 for 30 minutes after a meeting is registered, and
   while transcription or summarisation is running. See
   [ADR-0011](docs/adr/0011-admin-meeting-delete.md). No API lists meetings, so the
   id comes from the meeting's link or from the Supabase table.

4. Set `NUXT_R2_ACCOUNT_ID`, `NUXT_R2_ACCESS_KEY_ID`, `NUXT_R2_SECRET_ACCESS_KEY`,
   `NUXT_R2_BUCKET`. Scope the token to the one bucket with **Object Read & Write**
   — only the Object scopes can be bucket-scoped, and an Admin token could create
   or delete buckets if it leaked.

### Transcription setup (Groq)

Set `NUXT_GROQ_API_KEY` to transcribe with Whisper Large v3 Turbo. Without it `pnpm dev`
uses a deterministic stub transcriber, so the whole pipeline still runs.

Note the free tier allows 7,200 audio-seconds per rolling hour, about two hours of
audio. A recording longer than that uploads successfully and then hits the provider's
quota; the UI reports it as such.

### Embeddings setup (Cloudflare Workers AI)

Set `NUXT_WORKERS_AI_ACCOUNT_ID` and `NUXT_WORKERS_AI_API_TOKEN` (both, or neither) to
index meetings with `@cf/baai/bge-m3`. The token should be scoped to Workers AI alone.
Without them `pnpm dev` embeds with a deterministic stub, so indexing and questions still
run.

The Workers Free plan allows 10,000 neurons a day, resetting at 00:00 UTC, and has no
overage to bill. At about 1,075 neurons per million tokens that is roughly 9 million tokens.
Past it, indexing and questions are refused until the reset with a message saying so, and
indexing resumes from where it stopped. See
[ADR-0014](docs/adr/0014-workers-ai-embeddings.md).

### Database setup (Supabase)

1. Create a Supabase project, put its **Session pooler** connection string in
   `SUPABASE_DB_URL` (dashboard -> Connect; the port must be 5432, and the
   `[YOUR-PASSWORD]` placeholder has to be replaced by hand), then run
   `pnpm db:migrate`. It applies `supabase/migrations/*.sql` in timestamp order
   -- which matters, since later migrations backfill and replace what earlier
   ones create -- and records each one so a re-run is a no-op.
2. Set `NUXT_SUPABASE_URL` and `NUXT_SUPABASE_SERVICE_KEY` (the **service-role** key —
   it stays on the server; the table has RLS enabled with no policies).

### Deploying the Worker (Phase 13)

Nothing has been deployed yet. When it is:

1. `pnpm db:migrate`, for the migrations this needs, including `20261103180000_sweeper.sql`,
   without which every tick fails.
2. `NITRO_PRESET=cloudflare_module pnpm build`, then `wrangler deploy`. That is what registers the
   cron in `wrangler.jsonc`: one tick every 5 minutes, of the 5 crons the free plan allows. It
   can take up to 15 minutes to reach Cloudflare's network, and a new Worker up to 30 to show in
   Past Cron Events.
3. Upload a meeting, close the tab, and watch it move: `select last_tick_at from sweep_state`
   says a tick ran, and a line in `wrangler tail` says a step did. A tick with nothing to do logs nothing.
4. Ask for `/__scheduled` and `/cdn-cgi/local/scheduled` on the deployed host, which should run no
   tick, and check that `last_tick_at` does not move for it.

**The retention purge is off, and nothing here turns it on.** Set `NUXT_RETENTION_PURGE_DAYS` with
`wrangler secret put` to have a tick with nothing else to do delete one meeting past that many days:
its row, transcript, summary, index and audio, for good, at most 288 a day. It needs
`20261103190000_retention_purge.sql` applied, and `NUXT_PUBLIC_DEMO_MEETING_ID` naming a real
meeting, or it deletes nothing. A demo id naming no meeting says so once per isolate, and a
migration not applied says only `sweep failed: Error`, on each tick with nothing else to do. The
upload page says how many days from the setting, a well-formed id and being a Worker, with no
read of the database, so it goes on promising deletion in both of those cases: check both when
turning this on. Run the query in [ADR-0017](docs/adr/0017-retention-purge.md) first, to see what
the first days would delete.

The sweeper is also what keeps a free Supabase project from pausing: every tick writes one row,
including one with nothing to do. Whether Supabase counts that as activity is not known yet, so
watch the project's first idle week. See [ADR-0012](docs/adr/0012-pipeline-orchestration.md)'s step 11
addendum for what a tick retries, which is no failed stage, and what stays unproven.

## Scripts

| Script | Purpose |
| --- | --- |
| `pnpm dev` / `pnpm build` / `pnpm preview` | Develop, build, preview |
| `pnpm lint` / `pnpm lint:fix` | ESLint (flat config, stylistic rules) |
| `pnpm typecheck` | `nuxt typecheck` (vue-tsc, strict) |
| `pnpm test` / `pnpm test:watch` | Vitest unit + Nuxt-runtime tests |
| `pnpm test:e2e` | Builds the app, then tests the Nitro routes against the local drivers |
| `pnpm test:services` | Exercises the real R2, Supabase, Groq and Workers AI services; each group is skipped unless its keys are set, and the banner names which ones skipped |
| `NUXT_INVITE_CODE=<code> node scripts/drive-upload.mjs <url> [fixture] [dataDir]` | Headless Chromium: wrong code, right code, drop → extract → upload → progress page, inspects storage, then checks the page reaches `ready` with no click, a second tab that only watches and takes over, leaving and coming back, and the read-only demo, all by the requests each tab was seen to send. Takes the code the server was started with, and a server on local drivers, so started with `NUXT_ALLOW_LOCAL_DRIVERS=true` if built |
| `node scripts/drive-player.mjs <url> <meetingId>` | Headless Chromium: click-to-seek, active-line highlight, transcript keyboard navigation |
| `NITRO_PRESET=cloudflare_module pnpm build && node scripts/verify-worker-gate.mjs` | Runs the Worker build under local workerd with fake services, and checks what it refuses and what it selects ([ADR-0016](docs/adr/0016-real-services-or-nothing.md)). Run `pnpm build` afterwards, since the other jobs need the Node build |
| `pnpm test:postgrest` | The real Supabase drivers against a throwaway Postgres behind PostgREST (Docker). No credentials, and no real project |
| `NITRO_PRESET=cloudflare_module pnpm build && node scripts/verify-worker-sweep.mjs` | Runs the Worker build under local workerd and asks it for cron ticks, against real SQL on a throwaway Postgres and fake providers: a meeting with no tab open reaches `ready`, a tick with nothing to do still writes to Postgres, and what it refuses and leaves alone. Then `pnpm build` to put the Node build back |
| `scripts/verify-migrations.sh` | Applies `supabase/migrations/` to a throwaway Postgres (Docker) and asserts the schema invariants |
| `pnpm db:migrate` | Applies `supabase/migrations/` to the real project at `SUPABASE_DB_URL`, in order, skipping what a ledger says is already there. Run `verify-migrations.sh` first; pass `--dry-run` to see what is pending |
| `pnpm ci:local` | Runs every job in `.github/workflows/ci.yml` on this machine — a PR can be judged green without waiting on GitHub. A job it cannot run counts as a failure, not a skip |

## Roadmap

Phases 0-8 of the [playbook](docs/PLAYBOOK.md) are done: scaffold, FFmpeg spike,
in-browser extraction, upload & storage, transcription, the transcript viewer with
click-to-seek playback, structured summaries with decisions and action items,
and semantic Q&A over a meeting with verified, clickable citations. Phase 8's archive
and cross-meeting search were later removed, leaving each meeting reachable only through
its own link ([ADR-0013](docs/adr/0013-private-meeting-links.md)), and uploading now takes an
invite code ([ADR-0015](docs/adr/0015-invite-only-uploads.md)).
Several playbook instructions were changed after re-checking their premises — see
[ADR-0004](docs/adr/0004-transcription.md),
[ADR-0005](docs/adr/0005-audio-playback-and-transcript-sync.md),
[ADR-0006](docs/adr/0006-structured-summaries.md),
[ADR-0007](docs/adr/0007-semantic-qa.md) and
[ADR-0008](docs/adr/0008-cross-meeting-search.md). Pipeline orchestration is built up to its
browser driver and its cron sweeper: the progress page takes a meeting through every stage by
itself for as long as a tab has it open, and on a deployed Worker the server carries on with it closed, at
most one step every 5 minutes ([ADR-0012](docs/adr/0012-pipeline-orchestration.md)). A Node server
has no cron, and there a meeting waits for its page. That has run only under local workerd, since nothing
has been deployed. Next: rate limiting, Cloudflare Workers.

## Acknowledgements

Claude, Anthropic's AI model, was also used for building DevSprint. Claude worked on some commits in this repository.

## License

[MIT](LICENSE)
