# MeetMind: Zero-to-Deployed Execution Pathway (No-Code Technical Playbook)

> Note, 2026-11-02: this is the original plan, kept as written. Gemini is no longer used anywhere in MeetMind; embeddings come from Cloudflare Workers AI ([ADR-0014](adr/0014-workers-ai-embeddings.md)).

## TL;DR
- **Recommended stack:** Extract/compress audio client-side in a Web Worker with single-thread ffmpeg.wasm (@ffmpeg/core 0.12.x), encoding to 16kHz mono Opus (~7-11MB per hour, well under Groq's 25MB free cap); transcribe on Groq Whisper Large v3 Turbo (2,000 requests/day free, 216x real-time per Groq/Artificial Analysis) with Gemini 2.5 Flash audio as fallback; extract summary/decisions/action items with Vercel AI SDK v6 `generateText` + `Output.object()` and Zod on Groq llama-3.3-70b-versatile; embed transcript segments with gemini-embedding-001 at 768 dims into Supabase pgvector (HNSW); play with Wavesurfer.js v7 using server-precomputed peaks; deploy on Cloudflare Workers **free** tier (streaming AI proxies are I/O-bound and stay under the 10ms CPU limit).
- **The two risky phases** are the FFmpeg WASM spike and the bidirectional transcript↔player time-sync; budget extra time there. Everything else is well-trodden.
- **Total cost stays at 0 EUR/month** on free tiers if you avoid ffmpeg core-mt (which forces COOP/COEP headers that break third-party embeds) and use Cloudflare free tier; the whole build is realistically **10-13 weeks part-time** at 8-10h/week.

---

## Key Findings (verified facts vs. recommendations)

**Verified (with sources, mid-2026):**
- ffmpeg.wasm is the last actively maintained FFmpeg JS port (fluent-ffmpeg archived May 2025, ffmpeg-kit retired June 2025). Current package @ffmpeg/ffmpeg 0.12.15; single-thread @ffmpeg/core ~31MB, multi-thread @ffmpeg/core-mt ~32MB. Has a new maintainer and recent releases in 2025. Runs in a Web Worker by default.
- WASM linear memory is capped at 2GB (hard); large input files can crash `writeFile()` before processing. WORKERFS mount reads a File without copying into memory (a community fork read a 13.2GB mkv this way; documented in ffmpeg.wasm discussion #516/#755).
- Multi-thread core is ~2x faster than single-thread (official ffmpeg.wasm performance benchmark: single-thread 0.12.3 ran a full 720p transcode at ~0.04x real-time / 128.8s avg, core-mt at ~0.08x / 60.4s avg) but requires SharedArrayBuffer, which requires COOP (`same-origin`) + COEP (`require-corp`) headers; these break iframes and cross-origin scripts. Official FAQ calls core-mt "unstable."
- Groq Whisper: 25MB file cap on free tier (100MB dev tier, URL only), models downsample to 16kHz mono internally. Per Groq's launch post citing Artificial Analysis, "Groq's implementation of Whisper Large v3 Turbo clocks in at a speed factor rate of 216x real-time"; whisper-large-v3 was "independently benchmarked... at a real-time speed factor of 299x" (WER held at 10.3%). In practice, per eesel AI's 2026 Groq analysis, "an hour of audio processes in about 15 seconds." verbose_json gives segment timestamps; word timestamps supported (extra latency). Per Groq's Rate Limits docs, "Both Whisper models give you 2,000 requests per day and 7,200 audio seconds per hour."
- Groq llama-3.3-70b-versatile free tier (as of June 4, 2026): 30 RPM, 1,000 RPD, 12,000 TPM, 100,000 TPD.
- Gemini free tier (2026): Flash models only (Pro moved behind billing Dec 2025); Gemini 2.5 Flash ~10 RPM / 250 RPD / 250K TPM; native audio understanding handles ~9.5 hours per request, can transcribe with timestamps + speaker labels via prompt. gemini-embedding-001: 768/1536/3072 dims (MRL), 2,048 token input cap, ~10M tokens/min embedding free tier, ~1,500 embedding requests/day free.
- Supabase free tier: 500MB Postgres DB with pgvector, Storage 1GB total with 50MB per-file cap, 7-day inactivity pause (needs keep-alive), no automatic backups. pgvector 0.8+ supports iterative index scans for filtered queries; HNSW is default index.
- Cloudflare Workers free tier: per the Workers Limits docs, the free plan has "a daily request limit of 100,000 requests, resetting at midnight UTC," a 10ms CPU-time cap per request, 128MB memory per isolate, and 50 subrequests per invocation. Critically, per Cloudflare's docs, "CPU time is active processing time: not time spent waiting on network requests, storage calls, or other general I/O, which don't count towards your CPU time" — so streaming AI proxies (mostly waiting) are viable on the free tier. R2 free tier: 10GB storage, zero egress, 1M Class A + 10M Class B ops/month.
- Vercel Hobby: non-commercial only; functions default 60s (Node), Fluid Compute enabled; 12 functions/deployment cap.
- Wavesurfer.js v7 (~7.12.x): TypeScript rewrite, Shadow DOM, HTML5-audio/video backend only, Regions plugin (Markers removed), client-only in Nuxt. Recommends pre-decoded peaks for large files (generate with bbc/audiowaveform); streaming supported only with pre-decoded peaks + duration.
- Vercel AI SDK 6 (Dec 2025): `generateObject`/`streamObject` deprecated in favor of `generateText`/`streamText` + `Output.object()`; Zod schemas; @ai-sdk/vue Chat class; Groq is a community-maintained provider.
- Nuxt 4 stable since July 2025; 4.4.x current (March 2026), Vue Router v5, app/ directory, per-context TypeScript projects. Nuxt 3 maintenance ends July 31, 2026.
- Diarization: Groq Whisper does NOT diarize. AssemblyAI gives $50 free credits (~185 hours base) and includes diarization in base price on some plans; per Deepgram's pricing, you "get started with $200 in credit (up to 45,000 free minutes)... No credit card is required." Gemini can diarize via prompt (best-effort, not guaranteed accurate).

**Verdicts (recommendations):**
1. **Extraction:** single-thread ffmpeg.wasm, audio-only (`-vn`), encode to Opus 16kHz mono. Reject core-mt (COOP/COEP breaks embeds, marginal gain). Consider mediabunny (WebCodecs) as a documented faster alternative/stretch since AudioDecoder is now broadly supported.
2. **Transcription:** Groq Whisper Large v3 Turbo primary; Gemini 2.5 Flash audio fallback. Reject in-browser transformers.js Whisper as primary (too slow for 1hr meetings) but keep as offline stretch goal.
3. **Format:** 16kHz mono Opus (~7-11MB/hr). Reject FLAC for full-hour uploads (~55-75MB exceeds 25MB cap despite Groq's lossless recommendation).
4. **Player:** Wavesurfer.js v7 with server-precomputed peaks + Regions plugin.
5. **DB:** Supabase pgvector, dense-only search (hybrid is overkill for transcripts).
6. **Host:** Cloudflare Workers free tier.

---

## Details: The Phased Pathway

### Phase 0 — Scoping, Fixtures, Wireframes (1 week, ~8h)
**Goal:** Lock scope, pick a demo meeting, sketch the five core screens.

1. Write a one-page product definition and the "no raw video leaves the browser" privacy thesis (this is the portfolio differentiator).
2. Select/record a demo meeting: a 3-5 minute multi-speaker clip (Creative Commons or self-recorded with consent) plus a tiny 30-second fixture for automated tests.
3. Wireframe five screens: (a) upload/drop zone with in-browser compression progress, (b) multi-stage pipeline progress, (c) transcript + waveform split view, (d) summary/decisions/action-items panel, (e) archive + cross-meeting search (the archive became a per-browser list and search was removed, see ADR-0013).
4. Decide scope cuts up front: diarization = stretch goal; live recording = stretch; WebGPU offline = stretch.

**Packages introduced:** none (design tools only).
**Key decision:** Descope diarization to a stretch goal. Rejected: building diarization into the MVP (Groq Whisper cannot diarize; free-credit providers deplete; Gemini prompt-based diarization is unreliable).
**Acceptance:** README skeleton exists with the ADR list; demo + test fixtures committed.

### Phase 1 — Repo & Nuxt 4 Setup (0.5 week, ~5h)
**Goal:** A running Nuxt 4 app with strict TypeScript and CI.

1. Scaffold a Nuxt 4 project (4.4.x), enable strict TypeScript, set up the app/ directory structure.
2. Add linting/formatting, a CI workflow (typecheck + lint + test), and commit conventions.
3. Add a UI layer (Nuxt UI or Tailwind) and set up the route/layout skeleton for the five screens.
4. Configure Nitro server routes as the only place secrets live.

**Packages:** `nuxt` (4.4.x, framework), `@nuxt/ui` or `tailwindcss` (UI), `eslint`/`prettier` (quality), `vitest` (unit tests), `zod` (schema validation, shared).
**Acceptance:** App builds, typechecks strict, CI green, all five routes render placeholders.

### Phase 2 — FFmpeg WASM Spike (RISKY, 1.5-2 weeks, ~15h)
**Goal:** Prove a 1-hour 720p video becomes a 16kHz mono Opus file in the browser, in a worker, with progress — and confirm it fits under 25MB.

1. Add ffmpeg.wasm (@ffmpeg/ffmpeg + @ffmpeg/util) and self-host the single-thread @ffmpeg/core assets (do NOT load core from a cross-origin CDN under cross-origin isolation; bundle/serve from your own origin).
2. Run extraction inside a Web Worker (ffmpeg.wasm already spawns its own worker; wrap your orchestration in a dedicated worker to keep the main thread free and to pass the File as a transferable).
3. Use audio-only extraction (drop the video stream with `-vn`, resample to 16kHz, downmix to mono, encode Opus at ~16kbps). Audio-only avoids the expensive video-decode path that makes full transcodes run at ~0.04x real-time in the single-thread core; skipping video decode is orders of magnitude cheaper.
4. Wire the ffmpeg progress event to a progress bar.
5. For large inputs (~1GB+), mount the File via WORKERFS instead of copying into MEMFS to avoid the 2GB linear-memory ceiling; if WORKERFS is impractical, split by time segments using File.slice. Note that `exit()`/`terminate()` are reported not to reliably reclaim memory, so for batch use recreate the worker/context.
6. Measure: output size and wall-clock time on a real 1-hour video; document results in an ADR.

**Sizing reference (bitrate math, 1 hour, 16kHz mono):** Opus 16kbps ≈ 7.2MB, Opus 24kbps ≈ 10.8MB, MP3/Vorbis 48kbps ≈ 21.6MB (all fit the 25MB cap); MP3/Vorbis 64kbps ≈ 28.8MB and FLAC ≈ 55-75MB and WAV ≈ 115MB all exceed it.

**Packages:** `@ffmpeg/ffmpeg` (WASM FFmpeg wrapper), `@ffmpeg/util` (fetchFile/toBlobURL helpers), `@ffmpeg/core` (single-thread WASM core, self-hosted).
**Key decisions:**
- **Single-thread over multi-thread:** avoids COOP/COEP cross-origin isolation which breaks third-party embeds and complicates CDN loading. Rejected core-mt (~2x faster but "unstable" per official FAQ, and forces cross-origin isolation).
- **Opus over FLAC/WAV:** 1hr 16kHz mono Opus is ~7-11MB (fits 25MB cap); FLAC ~55-75MB and WAV ~115MB do not.
- **Consider mediabunny (WebCodecs) as fallback/alt:** GPU-accelerated, no 2GB WASM ceiling, but document as an alternative since it adds surface area.
**Acceptance:** A 1-hour test video produces a <25MB Opus file with a working progress bar; memory does not crash on a ~1GB file; ADR written with measured numbers.
**Time note:** This is the single riskiest phase; memory behavior on large files is the main unknown, and no published benchmark measures exactly "1hr 720p → audio-only in single-thread wasm," so measure it yourself early.

### Phase 3 — Upload & Storage (1 week, ~8h)
**Goal:** Compressed audio reaches durable storage via a signed URL; original video never persists.

1. Generate a presigned upload URL from a Nitro server route (never expose storage keys client-side).
2. Upload the compressed Opus directly from the browser to storage; simple single-PUT is sufficient (files are <25MB, so resumable/tus is overkill).
3. Persist only compressed audio + metadata; never store the original video (privacy ADR).
4. Store meeting metadata rows in Postgres.

**Packages:** `@supabase/supabase-js` (DB + Storage client) OR an S3-compatible client for R2; `nitropack` (bundled with Nuxt) for server routes.
**Key decision:** **Cloudflare R2 for audio blobs, Supabase Postgres for metadata/vectors.** R2 gives 10GB + zero egress vs Supabase Storage's 1GB/50MB-per-file. Rejected: storing audio in Supabase Storage (tighter caps). Rejected: resumable uploads (unnecessary for <25MB).
**Acceptance:** Upload a compressed file, see it in storage, metadata row created, no video persisted.

### Phase 4 — Transcription + Chunk/Timestamp Merge (1.5 weeks, ~12h)
**Goal:** Audio becomes a timestamped transcript, correctly stitched if chunked.

1. From a Nitro route, send the audio to Groq Whisper Large v3 Turbo with verbose_json and segment timestamps.
2. For audio over 25MB or very long meetings, chunk client-side (or server-side) into ~10-minute segments; reset each chunk's timestamps to zero, then add a running time offset per chunk when merging.
3. Add small overlaps between chunks and de-duplicate boundary segments during merge.
4. Persist transcript segments (meeting_id, start_ms, end_ms, text) to Postgres.
5. Implement the Gemini 2.5 Flash audio fallback path behind a provider flag.

**Packages:** `groq-sdk` or an OpenAI-compatible client (Whisper endpoint), `@ai-sdk/google` (Gemini fallback), `zod` (validate transcript shape).
**Key decisions:**
- **Groq Whisper Turbo primary:** free, extremely fast (216x real-time; ~15s per hour of audio), segment timestamps. Rejected OpenAI Whisper (not free), self-hosted whisper.cpp (needs server), transformers.js in-browser (too slow for 1hr as primary).
- **Timestamp offset math is a dedicated, unit-tested module** — the top correctness risk.
**Acceptance:** A 30-min audio yields a coherent transcript with monotonic timestamps; chunk boundaries have no duplicate/dropped text; fallback path works.

### Phase 5 — Transcript Viewer + Wavesurfer Sync (RISKY, 1.5-2 weeks, ~15h)
**Goal:** Bidirectional click-to-seek between transcript and waveform player.

1. Build the transcript viewer with each segment carrying its start/end ms.
2. Add a client-only Wavesurfer.js v7 component (wrap in `<ClientOnly>` to avoid SSR issues).
3. Precompute waveform peaks server-side (or once client-side after compression) and feed pre-decoded peaks + duration to Wavesurfer so a 1-hour waveform renders without decoding the whole file (Wavesurfer decodes entirely in-browser via Web Audio and can fail on large clips otherwise).
4. Wire two directions: clicking a transcript segment seeks the player; the player's time-update event highlights and auto-scrolls the active transcript segment.
5. Use the Regions plugin to highlight cited segments.
6. Add keyboard-accessible seek controls.

**Packages:** `wavesurfer.js` (v7 waveform player + Regions plugin). Optional: `bbc/audiowaveform` (peak precomputation, a system tool).
**Key decisions:**
- **Wavesurfer v7 with pre-decoded peaks** over decoding in-browser (memory-safe for long audio) and over peaks.js/custom canvas (Wavesurfer is more feature-complete).
- **Client-only rendering** to sidestep SSR/Shadow DOM pitfalls.
**Acceptance:** Clicking any transcript line seeks audio to that moment; playback highlights the current line and auto-scrolls; keyboard seek works.
**Time note:** Second-riskiest phase; the two-way sync and scroll-follow logic are fiddly.

### Phase 6 — Structured Summary & Action Items (1 week, ~10h)
**Goal:** Generate summary, decisions, and action items (assignee, task, due date, timestamp reference) reliably.

1. Define a Zod schema for the structured output (summary, decisions[], actionItems[{assignee, task, dueDate, timestampMs}]).
2. From a Nitro route, call Groq llama-3.3-70b-versatile via AI SDK `generateText` + `Output.object()` with the schema and descriptive `.describe()` hints.
3. For a 1-hour transcript (~7-10K words, roughly 10-13K tokens) that risks exceeding TPM/TPD, use a map-reduce pattern: extract per-chunk, then merge/reduce into final structured output.
4. Stream partial structured output to the UI for progressive rendering where useful.
5. Store extracted structured data linked to the meeting.

**Packages:** `ai` (Vercel AI SDK v6 core), `@ai-sdk/vue` (Chat/streaming to Vue), `@ai-sdk/groq` or community Groq provider, `zod`.
**Key decisions:**
- **`generateText` + `Output.object()`** (v6-preferred) over the deprecated `generateObject`.
- **Map-reduce for long transcripts** to respect Groq's free limits (measured 2026-10-25 for `openai/gpt-oss-120b`: 8K TPM, 200K TPD — see the ADR-0006 addendum). Token budget math: one 1hr transcript extraction is comfortably within a single day's TPD, but batching many demo meetings needs the map-reduce + rate-limit guarding.
- **Groq Llama primary, Gemini fallback** for structured extraction.
**Acceptance:** A meeting produces a valid, schema-conforming summary + decisions + action items with timestamp references; malformed outputs are retried.

### Phase 7 — Embeddings + Semantic Q&A with Timestamp Citations (1.5 weeks, ~12h)
**Goal:** Ask "what did we decide about the budget?" and get an answer citing clickable timestamps.

1. Chunk the transcript into semantically coherent segments with start/end ms as metadata.
2. Embed each segment with gemini-embedding-001 at 768 dims (batch within the 2,048-token input cap).
3. Store in a pgvector table (meeting_id, start_ms, end_ms, text, embedding vector(768)) with an HNSW index.
4. On a question: embed the query, run dense similarity search (top-k), pass retrieved segments to the LLM, and generate an answer that cites segment timestamps.
5. Render citations as clickable links that seek the Wavesurfer player.

**Packages:** `@ai-sdk/google` (embeddings), `@supabase/supabase-js` (pgvector queries via RPC), `zod`.
**Key decisions:**
- **Dense-only retrieval** (no hybrid keyword search). Verdict: hybrid is overkill for conversational transcripts where semantic match dominates; keep it simple. (Hybrid remains a documented stretch since pgvector supports tsvector + RRF.)
- **768 dims** balances quality and Supabase's 500MB DB cap (4x smaller than 3072).
- **gemini-embedding-001** to reuse sibling-project (TruthBase) knowledge.
**Acceptance:** Q&A returns relevant answers; every citation timestamp seeks the player to the right moment.

### Phase 8 — Archive + Cross-Meeting Search (0.5-1 week, ~8h)
> **Superseded by [ADR-0013](adr/0013-private-meeting-links.md).** This phase was built, then the global list and cross-meeting search were removed: without accounts they handed every meeting to anyone. Meetings are now reached only through their own link, "Your meetings" lives in the uploader's browser, and the demo meeting is linked through `NUXT_PUBLIC_DEMO_MEETING_ID`. The steps below are kept as the original plan.

**Goal:** Browse and search across multiple meetings.

1. Build the archive list with meeting metadata and quick filters.
2. Add cross-meeting semantic search (same embedding query path, without a meeting_id filter, or with iterative-scan-safe filtering).
3. Add a preloaded demo meeting so reviewers never need to upload.

**Packages:** reuse prior; no new load-bearing deps.
**Key decision:** Use pgvector 0.8+ iterative scans when filtering by metadata to avoid under-returning results.
**Acceptance:** Archive lists all meetings; cross-meeting search returns results with correct deep-links; demo meeting preloaded.

### Phase 9 — Pipeline Orchestration & Progress Streaming (1 week, ~10h)
**Goal:** The multi-stage pipeline (uploading → transcribing → summarizing → indexing) runs reliably and streams status.

1. Orchestrate stages from Nitro routes; stream progress to the client via Server-Sent Events.
2. Because Groq Whisper is near-instant (~15s/hour) and Llama is fast, the whole server pipeline can complete within a single streaming request on the chosen host without a queue.
3. Add graceful failure/retry messaging per stage.

**Packages:** Nitro's built-in SSE/streaming utilities; no external queue.
**Key decision:** **No queue.** Verdict: for free-tier scale, a single streaming request is the simplest reliable pattern. Rejected Cloudflare Queues / Nitro tasks as unnecessary complexity. On Cloudflare free tier, streaming proxy calls are I/O-bound (waiting on Groq), so they stay under the 10ms CPU limit even though wall time is seconds.
**Acceptance:** End-to-end pipeline completes with live per-stage progress; failures surface clearly.

> **Amended by [ADR-0012](adr/0012-pipeline-orchestration.md) (2026-10-25).** Points 1–2 and the "No queue … single streaming request" decision do not hold on the Workers free plan: 10 ms of CPU applies per invocation, and summarizing a one-hour meeting takes ~8 minutes of paced Groq calls. Each request now does one bounded step, the browser drives the loop, rate limits are coordinated in Postgres, and acceptance is **live per-stage progress by polling**.

### Phase 10 — Rate Limiting & Demo Protection (0.5 week, ~5h)
**Goal:** Protect free-tier quotas from demo abuse.

1. Add per-IP request caps via Nitro middleware / nuxt-security.
2. Add audio-specific caps: max upload duration and max uploads per IP per day.
3. Ensure the preloaded demo path bypasses upload entirely.
4. Document cost math: worst-case daily demo usage stays within Groq's 2,000 Whisper requests/day and 1,000 Llama RPD.

**Packages:** `nuxt-security` (headers + rate limiting).
**Acceptance:** Rate limits enforced; demo meeting always available; cost math documented in README.

### Phase 11 — UI Polish, Accessibility, PWA Decision (1 week, ~10h)
**Goal:** Production-grade UX and accessibility.

1. Keyboard navigation for seek/playback; focus management; ARIA for the transcript/player.
2. Consider captions/transcript-as-captions for the player.
3. Run Lighthouse / Core Web Vitals; record numbers for the README.
4. PWA/offline: **skip** for MVP (the compute-heavy, network-dependent pipeline gains little from offline); document the decision.

**Packages:** a Lighthouse module or manual Lighthouse; a11y linting.
**Key decision:** Skip PWA. Rejected offline mode as low-value for this network-bound app (revisit only with the WebGPU offline stretch goal).
**Acceptance:** Documented Lighthouse scores; keyboard-only operation works; accessibility pass complete.

### Phase 12 — Testing (1 week, ~10h)
**Goal:** Confidence in the fragile parts.

1. Unit tests (Vitest) for timestamp-offset math and chunk-merge logic — the highest-value tests.
2. Component tests for transcript↔player sync.
3. E2E (Playwright): upload the 30-second fixture → pipeline completes → transcript renders → clicking an action-item timestamp seeks the player. Assert player currentTime after the seek (audio playback itself is hard to assert; check the seek target, region highlight, and active-segment state rather than actual audio output).

**Packages:** `vitest` (unit/component), `@playwright/test` (E2E), `@vue/test-utils`.
**Acceptance:** Green CI including one full E2E happy path; offset/merge logic covered.

### Phase 13 — Deployment (0.5-1 week, ~8h)
**Goal:** Live demo on the chosen host within budget.

1. Deploy to Cloudflare Workers via the Nitro Cloudflare preset.
2. Because MeetMind's server work is API-proxying + DB + embeddings (no server-side video processing), it fits Cloudflare's **free** tier: streaming AI calls are I/O-bound and don't accrue CPU time. *(Withdrawn by ADR-0012: CPU is per invocation and the parsing, attestation and multi-chunk work around those calls does count. Each request is a bounded step instead, and the deploy measures per-step CPU.)*
3. If you ever choose the multi-thread FFmpeg path, set COOP/COEP headers (e.g., a Cloudflare `_headers` file) and self-host core assets — but the recommended single-thread path avoids this entirely.
4. Set up a Supabase keep-alive (cron/GitHub Action) to prevent the 7-day pause; configure DB backups to R2.
5. Configure all secrets as Worker environment variables.

**Packages:** `wrangler` (Cloudflare deploy), Nitro Cloudflare preset.
**Key decision:** **Cloudflare Workers free tier over Vercel Hobby.** Verdict: MeetMind offloads heavy compute to the browser, so Cloudflare's 10ms CPU limit is not a blocker for I/O-bound AI proxies, and it permits a public portfolio demo (Vercel Hobby is non-commercial and its function model is less favorable here). Rejected Cloudflare paid ($5/mo) as unnecessary without server-side heavy compute.
**Acceptance:** Public URL live with preloaded demo; Supabase keep-alive running; costs at 0 EUR.

### Phase 14 — README Whitepaper, ADRs, Demo Video (0.5-1 week, ~8h)
**Goal:** Portfolio-grade documentation.

1. Write the README as a technical whitepaper with ADRs: why client-side FFmpeg, why Groq Whisper over alternatives, why Opus, why the chunking/timestamp model, why dense-only retrieval, why single-thread over multi-thread, rejected alternatives.
2. Include architecture diagram, Lighthouse/CWV numbers, accessibility notes, and the cost math.
3. Record a demo video walking through upload → pipeline → transcript sync → Q&A with timestamp citations.

**Acceptance:** README reads as a whitepaper; ADRs present; demo video linked.

---

## Recommendations (staged, with thresholds)

1. **Do the FFmpeg spike first (Phase 2) before committing.** If a 1-hour video can't be processed reliably under ~2GB memory in your target browsers, pivot to mediabunny/WebCodecs (broadly supported now) or server-side extraction. Threshold to pivot: repeated OOM crashes on 1GB inputs even with WORKERFS.
2. **Ship the single-thread path.** Only revisit core-mt if measured processing time is unacceptable AND you can accept COOP/COEP breaking embeds. Threshold: audio-only extraction of 1hr taking more than a few minutes.
3. **Keep transcription on Groq free tier.** If demo traffic approaches 2,000 Whisper requests/day or 1,000 Llama RPD, add the Gemini fallback rotation and tighten per-IP caps rather than upgrading tiers.
4. **Stay dense-only for retrieval** unless evaluation shows keyword-heavy queries (proper nouns, budget figures) failing; then add pgvector hybrid (tsvector + RRF).
5. **Descope diarization to a stretch.** Only add it via AssemblyAI ($50 credits) / Deepgram ($200 credits, ~45,000 minutes) free credits for short demos if a reviewer specifically asks; document the honest tradeoff.
6. **Deploy on Cloudflare free tier.** Move to $5/mo Workers Paid only if you add server-side heavy compute (you shouldn't need to).

---

## Risk Register (top 5)

1. **ffmpeg.wasm memory limits on large files (2GB WASM ceiling).** Mitigation: audio-only extraction, WORKERFS mount to avoid MEMFS copy, File.slice segmenting, warn/reject inputs above a size threshold, spike this first.
2. **Groq free-tier exhaustion during demos.** Mitigation: preloaded demo meeting (no upload needed), per-IP daily caps, Gemini fallback, cost math kept under 2,000 Whisper RPD / 1,000 Llama RPD.
3. **COOP/COEP breaking third-party embeds.** Mitigation: use single-thread core (no cross-origin isolation needed); if forced to core-mt, isolate the FFmpeg page and self-host assets.
4. **Timestamp drift across chunks.** Mitigation: dedicated unit-tested offset/merge module, overlap + boundary de-duplication, reset-then-offset pattern.
5. **Supabase 7-day pause / data loss.** Mitigation: scheduled keep-alive (cron/GitHub Action), automated DB backups to R2, monitor egress/storage against 500MB/1GB caps.

---

## Definition of Done Checklist
- [ ] 1-hour video compresses to <25MB Opus in-browser with progress; no video persisted.
- [ ] Transcript renders with correct, monotonic timestamps (incl. chunked meetings).
- [ ] Clicking transcript/action-item/citation seeks the player; playback highlights active segment.
- [ ] Summary + decisions + action items (assignee/task/due date/timestamp) generated and schema-valid.
- [ ] Semantic Q&A answers with clickable timestamp citations.
- [ ] Meetings reachable only through their link, "Your meetings" lists this browser's uploads (ADR-0013); demo meeting preloaded.
- [ ] Rate limiting + demo protection active; cost math documented.
- [ ] TypeScript strict; Vitest + Playwright green in CI.
- [ ] Lighthouse/CWV numbers recorded; accessibility (keyboard seek) passes.
- [ ] Deployed on Cloudflare free tier; Supabase keep-alive running; 0 EUR/month.
- [ ] README whitepaper with ADRs + demo video.

## Stretch Goals
- Speaker diarization via AssemblyAI/Deepgram free credits (short demos).
- Live recording via MediaRecorder.
- WebGPU in-browser Whisper (transformers.js) for full offline mode.
- Meeting comparison across recordings.
- pgvector hybrid search (tsvector + RRF) if dense-only underperforms.
- mediabunny/WebCodecs extraction path as a faster GPU-accelerated alternative.

---

### Note on uncertainty
Free-tier limits and version numbers move frequently. Re-verify at build time: Groq free-tier caps (2,000 Whisper RPD / 7,200 audio-sec-hr; Llama 30 RPM / 1K RPD / 12K TPM / 100K TPD), Gemini free RPD, Supabase 500MB/1GB/50MB caps and pause policy, Cloudflare Workers 100K req/day + 10ms CPU, and current package versions (@ffmpeg/ffmpeg 0.12.15, Nuxt 4.4.x, Wavesurfer 7.x, AI SDK v6). The FFmpeg single-thread wall-clock for audio-only extraction of a 1-hour file is an inference (no published benchmark measures exactly that case) — measure it in Phase 2 and record the number in your ADR.
