# MeetMind

**Meeting videos in. Searchable, timestamped knowledge out. No raw video ever leaves your browser.**

MeetMind turns recorded meetings into timestamped transcripts, structured summaries
(decisions and action items with assignees), and a semantic Q&A archive — while keeping
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
│ gemini-embedding-2 (768d) ─► Supabase pgvector; questions   │
│   answered by gpt-oss, citations verified like summaries    │
│ cross-meeting search: same embeddings, no meeting filter,   │
│   capped per meeting via a LATERAL join, no HNSW yet         │
└───────────────┬──────────────────────────────────────────────┘
                ▼
   Transcript ↔ player over a byte-range route (click-to-seek both ways),
   semantic Q&A with clickable timestamp citations, search across meetings
   linking straight to the moment a passage was said
```

The full phased build plan lives in [docs/PLAYBOOK.md](docs/PLAYBOOK.md).

## Architecture Decision Records

| ADR | Decision |
| --- | --- |
| [0001](docs/adr/0001-client-side-audio-extraction.md) | Client-side audio extraction: single-thread ffmpeg.wasm, Opus 16 kHz mono |
| [0002](docs/adr/0002-ffmpeg-spike-results.md) | FFmpeg WASM spike results (measured numbers) |
| [0003](docs/adr/0003-upload-and-storage.md) | Upload & storage: direct-to-R2 presigned PUT, Supabase Postgres metadata, local drivers for dev/CI |
| [0004](docs/adr/0004-transcription.md) | Transcription: one request per meeting, no chunking, stub provider for credential-free dev |
| [0005](docs/adr/0005-audio-playback-and-transcript-sync.md) | Playback: same-origin byte-range route, native player before a waveform |
| [0006](docs/adr/0006-structured-summaries.md) | Summaries: chunked extraction, citations checked against the transcript |
| [0007](docs/adr/0007-semantic-qa.md) | Semantic Q&A: windowed Gemini embeddings, answers held to the same citation check |
| [0008](docs/adr/0008-cross-meeting-search.md) | Cross-meeting search: passages across meetings, not a synthesized answer; still no HNSW |
| [0009](docs/adr/0009-workers-measurement-spike.md) | Workers measurement spike before Phase 9: what the runtime actually does, measured rather than inferred |

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
cp .env.example .env  # optional: cloud credentials (see below)
pnpm dev            # http://localhost:3000
```

Without any credentials the app is fully usable: uploaded audio and meeting rows are
kept under `.data/` by the local drivers, and a stub transcriber stands in for Groq.
Set the variables below to switch to the production services (each group is
independent).

Once real keys are in place, `pnpm test:services` checks each one against the driver
that uses it — presigned uploads and CORS on R2, the schema and triggers on Supabase,
whether Groq's response really has the shape the parser assumes, and that Gemini
honours the 768-dimension request and ranks a question nearer the passage answering
it. Those contracts are the one thing the offline tests cannot prove.

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
   nothing against a burst, which is what the server-side budget is for.

4. Set `NUXT_R2_ACCOUNT_ID`, `NUXT_R2_ACCESS_KEY_ID`, `NUXT_R2_SECRET_ACCESS_KEY`,
   `NUXT_R2_BUCKET`. Scope the token to the one bucket with **Object Read & Write**
   — only the Object scopes can be bucket-scoped, and an Admin token could create
   or delete buckets if it leaked.

### Transcription setup (Groq)

Set `NUXT_GROQ_API_KEY` to transcribe with Whisper Large v3 Turbo. Without it the
server uses a deterministic stub transcriber, so the whole pipeline still runs.

Note the free tier allows 7,200 audio-seconds per rolling hour, about two hours of
audio. A recording longer than that uploads successfully and then hits the provider's
quota; the UI reports it as such.

### Database setup (Supabase)

1. Create a Supabase project, put its **Session pooler** connection string in
   `SUPABASE_DB_URL` (dashboard -> Connect; the port must be 5432, and the
   `[YOUR-PASSWORD]` placeholder has to be replaced by hand), then run
   `pnpm db:migrate`. It applies `supabase/migrations/*.sql` in timestamp order
   -- which matters, since later migrations backfill and replace what earlier
   ones create -- and records each one so a re-run is a no-op.
2. Set `NUXT_SUPABASE_URL` and `NUXT_SUPABASE_SERVICE_KEY` (the **service-role** key —
   it stays on the server; the table has RLS enabled with no policies).

## Scripts

| Script | Purpose |
| --- | --- |
| `pnpm dev` / `pnpm build` / `pnpm preview` | Develop, build, preview |
| `pnpm lint` / `pnpm lint:fix` | ESLint (flat config, stylistic rules) |
| `pnpm typecheck` | `nuxt typecheck` (vue-tsc, strict) |
| `pnpm test` / `pnpm test:watch` | Vitest unit + Nuxt-runtime tests |
| `pnpm test:e2e` | Builds the app, then tests the Nitro routes against the local drivers |
| `pnpm test:services` | Exercises the real R2, Supabase, Groq and Gemini services; each group is skipped unless its keys are set, and the banner names which ones skipped |
| `node scripts/drive-upload.mjs <url> [fixture] [dataDir]` | Headless Chromium: drop → extract → upload → progress page, then inspects storage |
| `node scripts/drive-player.mjs <url> <meetingId>` | Headless Chromium: click-to-seek, active-line highlight, transcript keyboard navigation |
| `node scripts/drive-search.mjs <url> <dataDir>` | Headless Chromium: search across two indexed meetings, click a result, confirm it seeks the right meeting's player |
| `scripts/verify-migrations.sh` | Applies `supabase/migrations/` to a throwaway Postgres (Docker) and asserts the schema invariants |
| `pnpm db:migrate` | Applies `supabase/migrations/` to the real project at `SUPABASE_DB_URL`, in order, skipping what a ledger says is already there. Run `verify-migrations.sh` first; pass `--dry-run` to see what is pending |
| `pnpm ci:local` | Runs every job in `.github/workflows/ci.yml` on this machine — a PR can be judged green without waiting on GitHub. A job it cannot run counts as a failure, not a skip |

## Roadmap

Phases 0-8 of the [playbook](docs/PLAYBOOK.md) are done: scaffold, FFmpeg spike,
in-browser extraction, upload & storage, transcription, the transcript viewer with
click-to-seek playback, structured summaries with decisions and action items,
semantic Q&A over a meeting with verified, clickable citations, and search across
every indexed meeting.
Several playbook instructions were changed after re-checking their premises — see
[ADR-0004](docs/adr/0004-transcription.md),
[ADR-0005](docs/adr/0005-audio-playback-and-transcript-sync.md),
[ADR-0006](docs/adr/0006-structured-summaries.md),
[ADR-0007](docs/adr/0007-semantic-qa.md) and
[ADR-0008](docs/adr/0008-cross-meeting-search.md). Next: pipeline orchestration,
rate limiting (which cross-meeting search's open endpoint makes more pressing —
see ADR-0008), Cloudflare Workers.

## License

[MIT](LICENSE)
