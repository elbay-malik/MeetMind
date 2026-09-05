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
│ Groq Llama 3.3 70B + AI SDK v6 ─► summary/decisions/actions │
│ gemini-embedding-001 (768d) ─► Supabase pgvector (HNSW)     │
└───────────────┬──────────────────────────────────────────────┘
                ▼
   Transcript ↔ Wavesurfer.js player (click-to-seek both ways),
   semantic Q&A with clickable timestamp citations
```

The full phased build plan lives in [docs/PLAYBOOK.md](docs/PLAYBOOK.md).

## Architecture Decision Records

| ADR | Decision |
| --- | --- |
| [0001](docs/adr/0001-client-side-audio-extraction.md) | Client-side audio extraction: single-thread ffmpeg.wasm, Opus 16 kHz mono |
| [0002](docs/adr/0002-ffmpeg-spike-results.md) | FFmpeg WASM spike results (measured numbers) |
| [0003](docs/adr/0003-upload-and-storage.md) | Upload & storage: direct-to-R2 presigned PUT, Supabase Postgres metadata, local drivers for dev/CI |
| [0004](docs/adr/0004-transcription.md) | Transcription: one request per meeting, no chunking, stub provider for credential-free dev |

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
and whether Groq's response really has the shape the parser assumes. Those contracts
are the one thing the offline tests cannot prove.

### Storage setup (Cloudflare R2)

1. Create an R2 bucket and an R2 API token with object read & write on it.
2. Add a CORS policy to the bucket (Dashboard → bucket → Settings → CORS Policy), so the
   browser may PUT to presigned URLs:

   ```json
   [
     {
       "AllowedOrigins": ["http://localhost:3000", "https://your-app.example"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["Content-Type"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

3. Set `NUXT_R2_ACCOUNT_ID`, `NUXT_R2_ACCESS_KEY_ID`, `NUXT_R2_SECRET_ACCESS_KEY`,
   `NUXT_R2_BUCKET`.

### Transcription setup (Groq)

Set `NUXT_GROQ_API_KEY` to transcribe with Whisper Large v3 Turbo. Without it the
server uses a deterministic stub transcriber, so the whole pipeline still runs.

Note the free tier allows 7,200 audio-seconds per rolling hour, about two hours of
audio. A recording longer than that uploads successfully and then hits the provider's
quota; the UI reports it as such.

### Database setup (Supabase)

1. Create a Supabase project and apply `supabase/migrations/*.sql` (Supabase CLI
   `supabase db push`, or paste into the SQL editor).
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
| `pnpm test:services` | Exercises the real R2, Supabase and Groq services; each is skipped unless its keys are set |
| `node scripts/drive-upload.mjs <url> [fixture] [dataDir]` | Headless Chromium: drop → extract → upload → progress page, then inspects storage |
| `scripts/verify-migrations.sh` | Applies `supabase/migrations/` to a throwaway Postgres (Docker) and asserts the schema invariants |

## Roadmap

Phases 0-4 of the [playbook](docs/PLAYBOOK.md) are done: scaffold, FFmpeg spike,
in-browser extraction, upload & storage, and transcription. Chunking was dropped after
re-checking its premise — see [ADR-0004](docs/adr/0004-transcription.md). Next:
transcript ↔ waveform sync, structured summaries, pgvector semantic Q&A, archive &
cross-meeting search, rate limiting, deployment on Cloudflare Workers.

## License

[MIT](LICENSE)
