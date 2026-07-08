# MeetMind

**Meeting videos in. Searchable, timestamped knowledge out. No raw video ever leaves your browser.**

MeetMind turns recorded meetings into timestamped transcripts, structured summaries
(decisions and action items with assignees), and a semantic Q&A archive — while keeping
the entire video on the user's machine. Audio is extracted and compressed **in the
browser** with ffmpeg.wasm; only ~7-11 MB of 16 kHz mono Opus per meeting hour is ever
uploaded. The whole stack runs on free tiers (target: 0 EUR/month).

> Status: early development. Currently built: repo scaffold, five-screen skeleton, and
> the ffmpeg.wasm audio-extraction spike ([ADR-0002](docs/adr/0002-ffmpeg-spike-results.md)).

## Architecture

```
┌────────────────────────── Browser ──────────────────────────┐
│ video file ─► ffmpeg.wasm (Web Worker, single-thread)       │
│              -vn, 16 kHz mono Opus @16 kbps (~7 MB/hour)    │
└───────────────┬──────────────────────────────────────────────┘
                │ compressed audio only (<25 MB)
                ▼
┌─────────────── Nitro server routes (secrets live here) ─────┐
│ Groq Whisper Large v3 Turbo ─► timestamped transcript       │
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

New decisions follow the [ADR template](docs/adr/0000-template.md).

## Project structure

```
app/            Nuxt 4 app: pages (5 core screens), layouts, components, composables
app/workers/    Web Worker sources (ffmpeg orchestration) — not auto-imported
server/api/     Nitro routes — the only place secrets are read
shared/utils/   Isomorphic utilities (timestamp formatting, …), unit-tested
public/ffmpeg/  Self-hosted ffmpeg.wasm core assets (copied on postinstall, gitignored)
docs/           Playbook + ADRs
tests/          Vitest unit tests (`tests/unit`) and Nuxt-runtime tests (`tests/nuxt`)
```

## Setup

Requires Node 24 (pinned in `.node-version`; [fnm](https://github.com/Schniz/fnm) picks it
up automatically) and pnpm via corepack:

```bash
corepack enable
pnpm install        # also copies ffmpeg core assets into public/ffmpeg/
cp .env.example .env  # fill in keys for server-side features
pnpm dev            # http://localhost:3000
```

## Scripts

| Script | Purpose |
| --- | --- |
| `pnpm dev` / `pnpm build` / `pnpm preview` | Develop, build, preview |
| `pnpm lint` / `pnpm lint:fix` | ESLint (flat config, stylistic rules) |
| `pnpm typecheck` | `nuxt typecheck` (vue-tsc, strict) |
| `pnpm test` / `pnpm test:watch` | Vitest |

## Roadmap

Phases 0-2 of the [playbook](docs/PLAYBOOK.md) are done (scaffold + FFmpeg spike).
Next: upload & storage (R2/Supabase), Groq Whisper transcription with chunk/timestamp
merging, transcript ↔ waveform sync, structured summaries, pgvector semantic Q&A,
archive & cross-meeting search, rate limiting, deployment on Cloudflare Workers.

## License

[MIT](LICENSE)
