# ADR-0001: Client-side audio extraction with single-thread ffmpeg.wasm, encoding to Opus 16 kHz mono

- **Status:** Accepted
- **Date:** 2026-07-08

## Context

MeetMind transcribes meeting videos. A 1-hour 720p recording is ~1 GB; uploading it
is slow, costs storage/egress, and leaks the raw video off the user's machine.
Groq's Whisper free tier caps uploads at 25 MB, and Whisper downsamples audio to
16 kHz mono internally anyway — everything above that is wasted bits. The privacy
thesis of the product is "no raw video ever leaves the browser."

## Decision

Extract and compress audio entirely in the browser using **single-threaded
ffmpeg.wasm** (`@ffmpeg/ffmpeg` 0.12.x with the single-thread `@ffmpeg/core`,
self-hosted from our own origin), running inside a Web Worker. The extraction is
audio-only (`-vn`), downmixed to mono, resampled to 16 kHz, and encoded to
**Opus at ~16 kbps** (~7.2 MB/hour), staying comfortably under the 25 MB cap.
Large inputs are mounted via WORKERFS rather than copied into the WASM heap
(2 GB hard ceiling), and a fresh FFmpeg instance is created per job because the
WASM heap is never shrunk once grown.

## Consequences

- Only compressed audio (~7-11 MB/hour) is ever uploaded; the raw video never
  leaves the browser. This is the product's portfolio differentiator.
- No SharedArrayBuffer → no COOP/COEP headers → third-party embeds keep working
  and Cloudflare deployment stays simple.
- Single-thread is ~2× slower than the multi-thread core; acceptable because the
  audio-only path skips the expensive video-decode work. Measured numbers live in
  [ADR-0002](0002-ffmpeg-spike-results.md).
- The default `@ffmpeg/core` build is GPL-2.0-or-later (x264/x265 are compiled
  in even though we don't use them). Fine for this open-source project; revisit
  with a custom LGPL core (no x264) if licensing requirements ever change.

## Alternatives considered

- **Multi-thread `@ffmpeg/core-mt`** — ~2× faster but officially flagged
  "unstable" and requires cross-origin isolation (COOP/COEP), which breaks
  iframes/cross-origin scripts and complicates hosting. Rejected.
- **FLAC/WAV upload (Groq's lossless recommendation)** — 1 hour is ~55-75 MB
  (FLAC) / ~115 MB (WAV), far over the 25 MB free-tier cap. Rejected.
- **Server-side extraction** — requires uploading the full video, defeating both
  the privacy thesis and the free-tier cost model. Rejected.
- **mediabunny (WebCodecs)** — GPU-accelerated, no 2 GB WASM ceiling; kept as
  the documented pivot path if the spike shows ffmpeg.wasm cannot handle 1 GB
  inputs reliably.
- **In-browser Whisper (transformers.js)** — too slow for 1-hour meetings as the
  primary path; kept as an offline stretch goal.
