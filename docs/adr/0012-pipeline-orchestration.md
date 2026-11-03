# ADR-0012: Pipeline orchestration under the Workers free plan

- **Status:** Accepted, amended by [ADR-0013](0013-private-meeting-links.md), [ADR-0014](0014-workers-ai-embeddings.md), [ADR-0015](0015-invite-only-uploads.md) and [ADR-0017](0017-retention-purge.md)
- **Date:** 2026-10-25
- **Supersedes:** PLAYBOOK Phase 9 point 2 and its "No queue … single streaming request" key decision. Amends ADR-0006 §2–3 (per-chunk retry, chunk-local attestation), ADR-0007 §5–7 (index claim, pacing), ADR-0011 (what blocks a delete) and the Phase 13 note that "streaming AI calls … don't accrue CPU time".

> **Note, 2026-11-02:** embeddings moved to Cloudflare Workers AI
> ([ADR-0014](0014-workers-ai-embeddings.md)). Where this ADR says Gemini or `gemini-embed`,
> read Workers AI and a slot of its own. Step 8 inherited three things: a block at the daily
> limit lasts until 00:00 UTC, not 1 h; an index batch must also stay within
> `MAX_BATCH_TOKENS`, which 16 windows at the full budget would not; and a 1024-dimension
> reply is a third larger, with the upsert's `JSON.stringify` costing more CPU than the parse,
> so `INDEX_BATCH` of 16 still has to be measured on real Workers CPU. Its addendum, at the
> end, says what became of each. The third is still open.

## Context

PLAYBOOK Phase 9 assumed the whole pipeline (transcribe, summarize, index) could run inside one SSE request. The reasoning was that the work is I/O-bound and so stays under the free plan's 10 ms of CPU. The measurements of 2026-10-25, taken under workerd against real services, disagree.

### What was measured (1-hour meeting)

| | Measured |
| --- | --- |
| Transcript | 828 segments |
| Extraction | ~9 chunks of 2,500 tokens |
| Groq `gpt-oss-120b` allowance | 8,000 TPM, so extraction is paced at 1 request/minute: **~8 minutes per meeting** |
| Subrequests per route | register 2, complete 3, transcribe 8 (one Whisper call ~11 s), summarize 19 (9 Groq + 10 Supabase), search-index 7, ask 6 |
| CPU per route | **not measured** |

Because CPU is unmeasured, we design for the worst case. Assume each of these can exceed 10 ms of CPU in one invocation, and that CPU adds up across one long-lived request:
- any JSON parse of a large provider reply;
- `reconcile()` over a whole meeting;
- any work that loops over several chunks.

### Platform facts this decision rests on

Checked 2026-10-25. "Verified" means it was read in the docs. Everything else is marked.

| Fact | Source | Status |
| --- | --- | --- |
| Free plan: **10 ms CPU per HTTP request** ("10 milliseconds of CPU time per invocation") | [limits](https://developers.cloudflare.com/workers/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/) | Verified |
| A Worker that keeps overrunning is terminated with Error 1102. Only occasional overrun is tolerated. | [limits](https://developers.cloudflare.com/workers/platform/limits/) | Verified |
| CPU counts only executing code. Waiting on `fetch()` or a database does not count. | [limits](https://developers.cloudflare.com/workers/platform/limits/) | Verified |
| "There is no hard limit on duration for HTTP-triggered Workers" (while the client stays connected) | [limits](https://developers.cloudflare.com/workers/platform/limits/) | Verified |
| 50 external subrequests per invocation on Free. R2 and other Cloudflare services count too, with a separate cap of 1,000. | [limits](https://developers.cloudflare.com/workers/platform/limits/), [changelog 2026-02-11](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/) | Verified |
| `waitUntil()` runs at most 30 s after the response or a client disconnect | [limits](https://developers.cloudflare.com/workers/platform/limits/) | Verified |
| 100,000 requests/day on Free | [pricing](https://developers.cloudflare.com/workers/platform/pricing/) | Verified |
| Isolates neither share nor keep state. "Do not use or mutate global state." | [how Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/) | Verified |
| Cron Triggers on Free: 5 per account, 10 ms CPU, 15 min wall time | [limits](https://developers.cloudflare.com/workers/platform/limits/) | Verified |
| Workflows on Free: 10 ms CPU per step, unlimited step wall time, 3,000 steps/day | [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) | Verified. Whether the 50-subrequest budget resets per step or per instance is **unresolved**. |
| Queue consumer CPU on Free | [Queues limits](https://developers.cloudflare.com/queues/platform/limits/) | **Conflicting** (30 s there, 10 ms in pricing) |
| Durable Object request and alarm CPU on Free | [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) | **Undocumented** |
| Whether CPU accumulates across one streamed (SSE) response | none | **Undocumented.** "Per request" wording implies yes. |
| Idle timeout on a streamed Worker response | none | **Undocumented** |
| Groq rate limits apply per organisation. `gpt-oss-120b`: 8K TPM, 200K TPD, 30 RPM. `retry-after` is sent only with a 429. | [Groq rate limits](https://console.groq.com/docs/rate-limits) | Verified, but the page calls its table a Developer-plan sample. The console's `/settings/limits` page is authoritative. |
| Whether a rejected Groq request counts against TPM | none | **Undocumented** |

### What follows from these facts

**One request cannot hold the pipeline.**
- An 8-minute extraction inside one HTTP request makes 9 provider-reply parses plus a whole-meeting `reconcile()` against one 10 ms budget. That holds whether the request streams SSE or not.
- A 40-chunk meeting with retries (`MAX_CHUNKS` = 40, 2 attempts each) needs up to 80 Groq calls, which is over 50 subrequests on its own.

**Every piece of coordination state is per-isolate today:**
- `sharedGroqPacer` and its `setTimeout` sleep;
- `indexingInFlight`;
- the `parts[]` / `withRetries` loop;
- the local fence variable;
- the `Retry-After` value, which is never stored at all.

On Workers, two summarize runs in different isolates both start with an empty pacer and can fire in the same minute. That is exactly the collision ADR-0006 added the shared pacer to prevent. ADR-0009 already named the choice: a Durable Object, Workflows, or Postgres rows.

**The browser already drives the pipeline.** The progress page starts each step with a button and waits on one blocking `$fetch`. Nothing on the server ever resumes a meeting by itself.

## Decision

### 1. Every invocation does one bounded step, and the browser drives the loop

A new route, `POST /api/meetings/:id/advance`, works as follows:
- It reads the meeting and its run rows.
- It picks the single runnable step and runs it.
- It persists the result in Postgres (or R2, for the raw Whisper reply).
- It returns `{ status, progress: {stage, done, total, etaSeconds}, next: 'continue'|'wait'|'done'|'failed', retryAt? }`.

`GET /api/meetings/:id/pipeline` returns the same progress shape, read-only, for tabs that are not driving.

The progress page loops through a `usePipelineDriver` composable:
- On `continue`, it calls `advance` again immediately.
- On `wait`, it sleeps until `retryAt` plus 0–2 s of jitter.
- On `done` or `failed`, it stops.
- A Web Lock (`navigator.locks`, `meeting:<id>`) makes one tab per browser the driver. Other tabs poll `GET /pipeline` every 5 s.
- The server stays the authority, through the step claim in §3.

**SSE is not used.** Short requests make it irrelevant whether CPU accumulates over a streamed response, or whether streams have an idle timeout. Neither question needs an answer.

**No Queues, Durable Objects or Workflows.** Their Free-plan CPU or subrequest behaviour is unverified, or conflicting in the docs. The only primitives used are HTTP Workers, Supabase (PostgREST and `rpc()`) and R2, which are all already in production.

### 2. Step boundaries

Every step's work is bounded by configuration, not by meeting length. Each step makes at most one provider call.

| Step | Work | Size bound | Subrequests |
| --- | --- | --- | --- |
| **T1 Whisper** | `claim_step` → R2 get → one Whisper call → `response.arrayBuffer()` → R2 put of the raw reply under the `meetings/` prefix, so the 30-day lifecycle rule (ADR-0010) expires orphans → `commit_step` | No JSON parse. The multipart body is built from a `FixedLengthStream` (prefix + R2 body + suffix, with the length known), not a 25 MB Blob copy. **Unverified** that Groq accepts it; the fallback is today's `FormData` path. | ~6 |
| **T2…n Parse page** | R2 range-read 64 KB from `byteOffset` → a scanner finds whole segment objects inside `"segments":[` and `JSON.parse`s each one separately → `normalizeSegments` → `append_segments` → extends the chunk plan incrementally | ≤ `SEGMENTS_PER_PAGE` (100) | 3–5 |
| **Last page** | Writes the `summary_chunks` plan, enforces `MAX_CHUNKS` (413 → `failed`/summarization, as today), CAS `transcribing → summarizing`, deletes the raw object | as above | 5 |
| **S chunk k** | `claim_step` → `reserve_slot('groq-chat')`. On a miss it returns `wait` and makes no provider call. On a hit: read `seg_from..seg_to` → one Groq call → `JSON.parse` + `wireSummarySchema` → `attestChunk` → `record_chunk` | ~2,500 input tokens, one reply (~1,780 tokens measured), attestation over ~92 segments | ~5 |
| **F finalize** | Read every chunk's attested result → `mergeReconciled` → `finalize_summary` | Tens of items; the transcript is never read | ~3 |
| **I index batch** | `claim_step` → plan windows for one segment range from the cursor → compare keys → embed ≤ `INDEX_BATCH` (16) windows → `upsert_windows` | 16 hashes, a 16-vector reply | ~6 |
| **ask** | Check `meeting_index_state` (no whole-transcript re-plan) → `reserve_slot` (bounded wait, §4) → `embedQuery` → top-4 search → one Groq call → attest against 4 windows | constant | ~7 |

How each step's size is kept constant:
- **Parse pages and chunk planning.** `planChunks` is a pure greedy pack over `estimateTokens`. Carrying `{chunkStartIdx, tokens}` in the cursor gives the same boundaries as one full pass. `planWindows` is a forward-only scan, so it slices the same way.
- **Chunk-local attestation.** The model is shown exactly `renderTranscript(chunk.segments)` (`summary/groq.ts`), so an honest quote can only come from that chunk. Attesting against the chunk alone therefore keeps every honest citation and needs no overlap. The one behaviour change: a hallucinated quote that happens to match text in another chunk used to be attested there and is now dropped. ADR-0006 §3 is amended to say so.
- **Merging across chunks.** `mergeReconciled` keeps today's cross-chunk dedup key `${segmentIdx}:${normalise(text)}`, the time sort, gapless renumbering and the zod output check. `reconcile()` stays, as the composition `mergeReconciled([attestChunk(model, segments)])`, so the existing reconcile specs pin equivalence.
- **Index batch size.** It drops from `MAX_BATCH` = 100 to 16. A 100-vector reply at the configured dimensions is a parse whose size grows with the meeting.

**Step priority** in `advance`, first match wins:
1. a cooled-down `failed` stage to retry;
2. transcription steps;
3. an extraction chunk, if a slot is free now;
4. an index batch, if any windows are pending;
5. finalize, once every chunk is done;
6. otherwise `wait` until the earliest `retryAt`.

Because of item 4, indexing runs during extraction's 60 s gaps. Q&A therefore usually becomes available before extraction finishes.

### 3. State in Postgres

All new tables reference `meetings` with `on delete cascade`.

**`pipeline_runs`** (one row per meeting and stage; PK `(meeting_id, stage)`)
- `stage`: `transcription` | `summarization` | `search_index`
- `run_id`
- `cursor jsonb`
- `step_token`, `step_lease_until`
- `attempts`, `last_error`, `retry_at`, `updated_at`

**`summary_chunks`** (PK `(meeting_id, chunk_no)`)
- `run_id`, `seg_from`, `seg_to`, `est_tokens`, `attempts`
- `result jsonb`: the **attested** items, the summary text and the dropped counts, not the raw wire output

**`provider_slots`** (one row each for `groq-chat`, `groq-whisper` and `gemini-embed`)
- `next_available_at`, `blocked_until`, `interval_ms`

**`meeting_index_state`**
- `text_hash`, `model`, `window_count`, `complete`
- This is also the index-completeness marker ADR-0008's addendum deferred. Cross-meeting search was to read it as well, but ADR-0013 removed that search.

**SQL functions** (each is one `rpc()` subrequest and one transaction):

| Function | What it does |
| --- | --- |
| `claim_step(meeting, stage, lease_ms)` | Sets a new `step_token` only `WHERE step_lease_until IS NULL OR step_lease_until < now()`. In the same transaction it bumps `meetings.updated_at`, fenced on status. A concurrent ADR-0011 delete, which is fenced on `updated_at`, therefore still loses cleanly. |
| `append_segments`, `record_chunk`, `finalize_summary`, `upsert_windows` | Each write carries `WHERE EXISTS (… step_token = $token)` **in the same statement**, then clears the token. `finalize_summary` does today's five summary writes plus the CAS `indexing → ready` in **one transaction**. This closes ADR-0006's "renew, then write without a transaction" gap everywhere. Upserts are keyed on natural ids, so a retried page is idempotent. |
| `reserve_slot(provider, max_wait_ms)` | One `UPDATE … SET next_available_at = greatest(now(), next_available_at, blocked_until) + interval WHERE greatest(...) <= now() + max_wait RETURNING`. On a miss it returns `retry_at` and reserves nothing. |
| `note_rate_limit(provider, retry_after_s)` | `blocked_until = greatest(blocked_until, now() + retry_after)` |

**Step leases are short and per step:**

| Step | Lease | Why |
| --- | --- | --- |
| Whisper | ~7 min | above the 5 min Whisper timeout |
| Chunk | ~3 min | above the 90 s Groq timeout |
| Page, finalize, index batch | ~1 min | |

These replace the 15 min and 4 h run leases as the recovery mechanism. A lease is never held while a step waits for a slot: a parked run holds no lease at all. A long `Retry-After` therefore can never make a slow-but-alive run look stale, and quota is never wasted on a spurious reclaim.

**Meeting statuses are unchanged.** No new value is added, so `audioIsStored`, `stored_audio_bytes`, the `failedStage` CHECK and the storage budget are untouched.
- `transcribing` and `indexing` keep meaning "this stage is in progress". It may be paused between steps.
- The `indexing → extracting` rename stays deferred.
- `PAST_TRANSCRIPTION` remains the guarantee that a finished transcript is never replaced. This ADR adds the first test for it.

### 4. Pacing: a try-acquire Postgres slot ledger

`provider_slots` replaces `sharedGroqPacer` for both summarize and ask. It is the one store that every isolate, and the Node build, shares.

- **`groq-chat`** keeps today's interval of 60,000 ms. It lives in the row, and runtime config sets it to ~0 for tests. Every attempt takes its own slot, retries included, so ADR-0006's contract holds, now across isolates as well.
- **Extraction** reserves with `max_wait = 0`. It never sleeps server-side; the browser does the waiting.
- **ask** reserves with `max_wait = 20 s` and sleeps in-request until its slot (waiting costs no CPU). If no slot is free within 20 s, or the provider is blocked, it answers **429 with `Retry-After`**. Nothing builds an unbounded queue any more, and asks cannot push extraction past a lease (leases are per step).
- **A Groq 429** always calls `note_rate_limit`, so the `Retry-After` that `summarize.post.ts:44-49` says is lost is now persisted and honoured by every caller. The cooldown becomes `max(RETRY_COOLDOWN_MS, blocked_until)`.
- **`gemini-embed`** gets a short interval (~1 s) and `blocked_until` on a 429. Whether Gemini sends `retry-after` is **unverified**; without it, a 1 h block applies.
- **`groq-whisper`** handles 429s reactively through `blocked_until`. A proactive audio-seconds ledger (7,200 s per hour) is deferred.

### 5. Failure and retry

**Killed steps.** A step killed by Error 1102, a deploy, or a closed tab after `waitUntil` runs out:
- Its lease expires and the next `advance` from any tab re-claims the step.
- The killed step's late writes match no token and do nothing.
- Each step is wrapped in `event.waitUntil` as a partial guard, which buys up to 30 s. **Unverified** that h3's `event.waitUntil` reaches the Workers `ctx` under Nitro's `cloudflare_module` preset.

**Per-chunk retry** (the resumable retry ADR-0006 and ADR-0009 deferred):
- `attempts` is incremented when the step is claimed, so a killed attempt also counts.
- A retryable failure (5xx, timeout, schema miss) on attempt 1 parks the chunk until the next slot.
- Attempt 2 failing, or any non-retryable error, moves the meeting to `failed`/summarization with the cooldown.
- Finished chunks are **kept**. The retry claim (`failed` → `indexing`, as today) resumes at the failed chunk. This is safe because the transcript is immutable past transcription.
- Chunk results are discarded only when `run_id` changes, i.e. on a re-transcription or a repair of `ready` with no summary row.

**Groq 429 during extraction.** It sets `blocked_until` and **parks** the chunk without spending an attempt. Three consecutive 429s on one chunk end in `failed`. This is a deliberate change from today, where a 429 fails the whole run.

**429 during transcription.** Routing is unchanged (`failed`/transcription plus cooldown), so `transcription-quota.spec.ts` stays meaningful. `Retry-After` now lengthens the cooldown.

**Indexing failures** never touch the meeting status. The run parks on `blocked_until`, and the skip-stored-windows rule makes resuming free.

**Deletion** (amends ADR-0011):
- `deletionBlocker` refuses while any `pipeline_runs` row holds a live `step_lease_until`. That replaces both the status-lease check and the per-isolate `indexingInFlight` map, which never worked across isolates.
- A run parked between steps is deletable. The cascade removes its rows, so any straggler's write matches nothing.
- The raw Whisper object is added to the delete path.

### 6. Disagreements settled while writing this

| Question | Settled as | Reason |
| --- | --- | --- |
| Whisper reply: `arrayBuffer()` or pipe `response.body` into `R2.put` | `arrayBuffer()` | R2 needs a stream of known length (per R2's Workers API; not re-checked here). The Groq reply may arrive chunked, so piping risks a failed put after the Whisper quota is already spent. `arrayBuffer()` is a native copy of a few hundred KB, with no JS parse. |
| ask on a slot miss: always 202, or a bounded wait | 20 s bounded wait, then 429 with `Retry-After` | Most questions answer in one request, and the queue stays bounded. |
| Release `indexing → summarizing` between chunks, or keep `indexing` for the whole extraction | Keep `indexing` | The concern behind releasing was that a parked run looks in-lease and cannot be deleted. Making `deletionBlocker` and stale-detection read **step** leases fixes that directly. It also avoids re-running the cooldown, failed and claim logic on every chunk. |
| Attestation slice: chunk ±2 segments, or the chunk exactly | The chunk exactly | The model never sees text outside its chunk (verified in `groq.ts`), so an overlap can only admit quotes it could not have read. |
| Cron sweeper in v1 | Deferred, as an optional PR. See the open questions. Built as step 11; see its addendum. | |

## Consequences

**Every invocation is O(constant) in CPU and in subrequests.**
- The largest step uses about 7 of the 50 subrequests, whatever the meeting's length or `MAX_CHUNKS`.
- If a step measures over 10 ms, a setting shrinks it (`SEGMENTS_PER_PAGE`, `INDEX_BATCH`, `CHUNK_BUDGET_TOKENS`); the design does not change.
- **The one exception** is the Whisper request body when the fixed-length stream is refused. The `FormData` fallback grows with audio size, up to 25 MB, and its CPU is unmeasured. It is the first thing PR 1 measures.

**A meeting with no tab open goes very slowly on a Worker, and does not move anywhere else.** (Amended by step 11; as written this said processing pauses.)
- On a deployed Worker, the sweeper takes at most one step every 5 minutes, shared with every other meeting. Elsewhere there is no cron, and a meeting stays where it is until a tab opens it.
- Either way it carries on from the last persisted step, and opening a tab goes back to full speed.
- This is said plainly in the UI, in steps and not in a time nobody has measured.

**Per-chunk results survive failures.** A failure at chunk 8 no longer throws away chunks 1–7.

**Quota coordination is now global across isolates**, and `Retry-After` is honoured.
- Supabase becomes a hard dependency of every provider call: an outage stops asks and extraction.
- Each Groq or Gemini call costs one extra subrequest, and each slot miss costs one more.

**Request volume rises.** A 1-hour meeting costs about 40–60 Worker requests (1 Whisper, ~9 pages, 9 chunks, ~9 slot misses, 1 finalize, ~7 index batches), plus the polls from passive tabs. That is far below 100,000/day. Groq's 200K TPD (about 40–45 one-hour meetings) still binds first.

**New SQL functions must stay in parity with the local driver.** They are guarded the way ADR-0010's `stored_audio_bytes` is: case-by-case parity tests, plus `test:services` cases against real Supabase.

**Behaviour changes that existing specs pin and must be updated:**
- the manual step buttons and their single blocking POSTs go away;
- an extraction 429 parks instead of failing;
- ask returns 429 when extraction holds the slots;
- chunk-local attestation;
- `deletionBlocker` reads step leases.

**A raw Whisper reply briefly exists in R2.**
- It is deleted after the last page.
- An orphan from a crash is cleaned up by the delete path and by the lifecycle rule (it sits under `meetings/`).
- `stored_audio_bytes` does not count it; its size is negligible next to the audio.

**PLAYBOOK changes:**
- Phase 9 acceptance becomes "live per-stage progress by polling".
- Phase 13 point 2 ("streaming AI calls … don't accrue CPU time") is withdrawn.
- Line 138's "100K TPD / 12K TPM" is corrected to 200K / 8K.

## Alternatives considered

- **One SSE request per pipeline (PLAYBOOK Phase 9 as written).** Rejected. CPU likely accumulates across it (undocumented either way), a 40-chunk run exceeds 50 subrequests, and Workers documents no idle timeout for streamed responses.
- **Cloudflare Workflows, one instance per stage, plus a cron sweeper.** This had the best UX: it completes with no tab open, and its per-step CPU, unlimited step wall time and durable `step.sleep` are all verified. Rejected for now because:
  - as designed, it kept one whole-reply Whisper `JSON.parse` step, which breaks the worst-case rule;
  - it rests on several unresolved points: whether 50 subrequests apply per step or per instance (forcing successor chaining), the 3,000 steps/day quota against ~53–62 steps per meeting, and the retry semantics of a step killed mid-call (a possible unpaced duplicate Groq request);
  - it needs a custom Nitro entry that depends on nitropack internals (`_module-handler.mjs` runs `scheduled` inside `waitUntil`), plus an inline replay runner to keep the Node build working.

  The step library here is written so a Workflow or cron driver can call it later.
- **Make only summarize step-wise and keep the other routes.** The simplest option with the least churn. Rejected because transcribe (whole Whisper parse plus ~828-row insert), the full-transcript plan read, the 100-vector index parse and ask's full re-hash would all stay single invocations whose cost grows with the meeting. Its rollout order (pacer first, the reconcile split pinned by the existing specs, routes kept as thin wrappers) is adopted.
- **A Durable Object as the Groq gate.** It gives strict global serialisation, but its Free-plan CPU and alarm semantics are undocumented, and it does not exist under the Node build. It stays the fallback if the extra Supabase subrequest per slot ever becomes the binding cost.
- **Cloudflare Queues with `max_concurrency: 1`.** Free-plan consumer CPU conflicts between two docs pages, a queue does not space requests by itself, and it does not cover `/ask`.
- **The Workers Rate Limiting binding.** Its counts are "eventually consistent" and "do not combine into one worldwide limit" ([docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)), so it is wrong for a provider quota. It remains the right tool for Phase 10's per-IP limits.
- **Relying only on Groq 429s.** Concurrent callers would collide first and back off afterwards, and whether rejected requests count against TPM is undocumented. 429s are kept as the backstop, not the pacer.

## Decisions taken with this ADR (2026-10-25)

- **CPU is not measured before building.** The steps are designed so their
  size is a setting; the real per-step CPU is read from Workers Logs at the
  Phase 13 deploy, and a step that measures over 10 ms is shrunk, not
  redesigned.
- **A meeting with no tab open moves only by the sweeper**, and resumes at full
  speed from the last persisted step when a tab opens it. A Cron sweeper that
  advances one step of one meeting every 5 minutes is the last PR of this phase; it
  also serves as Phase 13's Supabase keep-alive. Until then, processing paused
  outright, and it still does on anything but a deployed Worker: see step 11's addendum.
- **Questions and extraction share the Groq slot first come, first served.** A
  question waits at most 20 s for a slot, then answers 429 with `Retry-After`.
- **Progress is polled, not streamed.** Phase 9's acceptance becomes "live
  per-stage progress by polling". SSE can be layered on later as a reader of
  `GET /pipeline` if deployed CPU numbers show a long-lived request is safe.

## Implementation plan

Each PR ships on its own and keeps `pnpm ci:local` green. Specs that drove a
single blocking route move to a drive helper rather than being deleted.

1. **This ADR and the PLAYBOOK amendments.** Docs only.
2. **Durable slot pacer.** Migration: `provider_slots`, `reserve_slot`,
   `note_rate_limit`. A slot repository with Supabase and local drivers.
   Replaces `sharedGroqPacer` in the summarizer (the old routes wait
   in-request until their slot for now). Every Groq 429 calls
   `note_rate_limit`. *Acceptance:* a `test:services` case where concurrent
   reservations get exactly one grant per interval and `blocked_until` refuses
   them; a local/SQL parity spec; the summarizer's pacing specs retargeted at
   the slot repository.
3. **ask on the slot ledger.** 20 s bounded wait, then 429 with `Retry-After`;
   the question form says when to try again. *Acceptance:* an e2e ask while the
   slot is held returns 429 with `Retry-After` and succeeds after it.
4. **Split reconcile** into `attestChunk` and `mergeReconciled`, with
   `reconcile()` as their composition, and add `summarizeChunk` to both
   summarizers. *Acceptance:* the existing reconcile specs pass unchanged; a new
   spec pins the chunk-local drop of a quote that only exists in another chunk.
5. **Run ledger.** Migration: `pipeline_runs`, `summary_chunks`, `claim_step`,
   `record_chunk`, `finalize_summary`, with in-statement token fences and FK
   cascade; both drivers; `deletionBlocker` reads live step leases.
   *Acceptance:* parity specs, `test:services` rpc cases, deletion specs for a
   parked run, a live step and a straggler's late write; `verify-migrations.sh`.
6. **Step-wise extraction** behind the existing route (202 with progress, or
   200 when done) and an e2e drive helper. *Acceptance:* the summary specs
   ported and passing; a killed step resumes without redoing finished chunks; a
   chunk-k failure retries only from k; a 429 parks and completes; two
   concurrent drivers call each chunk exactly once.
7. **Step-wise transcription:** raw Whisper reply to storage under `meetings/`,
   paged parsing, incremental chunk plan. *Acceptance:* the incremental plan
   equals `planChunks`; the scanner handles objects split across pages; the
   transcription specs ported; a `ready` meeting's transcript is never replaced.
8. **Step-wise indexing** and the durable index claim replacing
   `indexingInFlight`; `meeting_index_state`. *Acceptance:* sliced window plans
   are identical to the whole plan; quota interruption resumes; ask refuses
   while the marker is incomplete.
9. **`POST /advance` and `GET /pipeline`**, with the step priority above; the
   per-stage routes become one-step wrappers. *Acceptance:* `driveToDone` takes
   the fixture from `uploaded` to `ready` with the index complete.
10. **Client driver and progress UI:** `usePipelineDriver`, one driving tab per
    browser, a stepper with the next-request countdown, a pause banner, retry
    only after failure. *Acceptance:* the browser job reaches `ready` without
    clicks; a second tab shows progress without driving.
11. **Cron sweeper.** One step of one meeting every 5 minutes. *Acceptance:* a
    meeting with no open tab reaches `ready` on the deployed Worker (Phase 13).

The real-Worker CPU check (no Error 1102, every step under 10 ms, every
invocation within its subrequest budget) is part of Phase 13's deploy.


## Addendum: the run ledger as built (step 5, 2026-10-25)

Step 5 (`20261026120000_pipeline_runs.sql`) differs from §3 in these ways:

- **Three more functions.**
  - `release_step` ends a step without a result: a failure, or a slot miss. Without it, a parked step would hold its lease until the lease expired.
  - `plan_chunks` writes the extraction plan under the step's token. A plan that already exists for the run is kept, results and all, so a retried planning step redoes nothing.
  - `locked_step_run` is the shared fence.
- **The fence is a row lock, not a `WHERE EXISTS`.** Each write first locks the stage's run row `FOR UPDATE`, matching on the token. Postgres re-reads a row that another transaction changed before granting the lock. A straggler whose step was re-claimed meanwhile therefore finds no row. `EXISTS` would read a snapshot that could predate the re-claim.
- **`claim_step` takes the meeting's expected status** (`p_status`) and locks that row first. It refuses, and moves nothing, when the meeting is elsewhere.
  - `p_chunk_no` counts the attempt on the chunk.
  - `p_new_run` starts the stage over under a new `run_id`. The old run's chunks are then stale: `plan_chunks` removes them, and nothing reads them.
- **`finalize_summary` refuses outright while a chunk of the plan has no result**, rather than merging without it.
- **Stored chunk results are checked again when read back**, both their shape and that every item cites a line inside its chunk. A result that fails reads as "not done", so the chunk is extracted again rather than merged. `recordChunk` applies the same check before writing.
- **`deletionBlocker` reads step leases in addition to**, not instead of, the status leases and `indexingInFlight`. Until steps 6–8 move extraction, transcription and indexing onto step leases, the old routes hold only the old claims, and dropping those checks now would let a delete run under them.

**Fixes from review** (`20261026130000_pipeline_runs_fixes.sql`, a separate migration because the first was already applied):
- **One lock order: the meeting, then the run row.**
  - `claim_step` and the fenced delete already took the locks in that order. The token-fenced writes took them the other way round, so a write by a step whose lease had just expired, racing a re-claim, deadlocked (40P01, reproduced).
  - `locked_step_run` now locks the meeting first.
- **An attempt is refunded when no provider call was made.** A step claims first and then reserves its slot, so a slot miss or a 429 parks it with nothing spent. `release_step(p_refund_attempt)` gives the claim's attempt back, to the chunk it claimed (`step_chunk_no`) or to the run. `claim_step(p_reset_attempts)` counts the claim as attempt 1, for the retry out of `failed`.
- **A chunk that already has its result is not claimed again.** Two drivers that both read the chunk as unfinished therefore spend one provider call, not two.
- **`record_chunk` takes the chunk's segment range and refuses a mismatch.** A result is only stored under the range it was checked against. A step works from `listChunks`, not from the plan it passed to `planChunks`, because a retried planning step keeps the stored plan.
- **Both drivers accept the same leases:** whole milliseconds from 1 to 2³¹−1.

**For step 6:**
- `claim_step` moves `meetings.updated_at`, which restarts the old 4 h status lease on an `indexing` meeting. When extraction moves onto step leases, that status lease has to come out of `deletionBlocker` and `claimLooksStale`. Otherwise a parked run stays undeletable.
- The "three consecutive 429s" counter needs a home. The likely place is the run's `cursor`, written under the step's token.

## Addendum: step-wise extraction as built (step 6, 2026-10-25)

`POST /api/meetings/:id/summarize` now does one step per request (`server/utils/summary/steps.ts`): plan the chunks, extract one chunk, or finalize. It answers 200 with `{ meeting, summary }` once the summary is stored, and 202 with `{ meeting, progress: { done, total, lastError }, next, retryAt, retryAfterMs }` otherwise. The page waits `retryAfterMs`, a duration measured on the server, not `retryAt` against its own clock, which may be minutes off. The progress page loops on it until the 200; step 9's `/advance` will call the same library.

**One more migration** (`20261026140000_pipeline_steps.sql`):
- `claim_step(p_move_to)` moves the meeting into the stage in the claim's own transaction. Entering extraction from `summarizing`, a cooled-down `failed`, or a `ready` meeting with no summary is therefore one write. A status compare-and-swap after the claim would leave a crash window: the meeting moved, the new run unplanned.
- `release_step(p_cursor)` stores the run's cursor under the token. It holds the consecutive-429 count: `{ rateLimited: { chunkNo, count } }`.
- `claim_step(p_redo)` claims a chunk whose stored result failed its read-back check, clearing it (see below).
- `release_step(p_fail_from)` moves the meeting to `failed` under the token. A step that waited out its lease on the provider cannot fail a run another step has taken over since. Only transcription and summarization may fail the meeting this way.

**How a step is chosen** (first match wins):
1. `ready` with a summary: done. `ready` without one, or `summarizing`: claim a new run and plan it.
2. `failed`/summarization:
   - Refused until the cooldown has passed: `max(updatedAt + 60 s, the run's retryAt)`, so a provider block longer than the cooldown is honoured.
   - After that, the claim resumes the run. It goes to the first chunk without a result, with that chunk's attempts reset; otherwise it finalizes, or plans if there is no plan.
3. `indexing`:
   - A live step lease answers `wait`, retrying at the earlier of the lease's end and 2 s from now.
   - A `retryAt` in the future answers `wait` without claiming anything.
   - Otherwise the step is the next unfinished chunk, or the finalize step once every chunk is done.

**Chunk outcomes:**
- A **slot miss** refunds the attempt and parks the chunk until the slot's time. It neither adds to nor resets the 429 count.
- A **provider 429** refunds the attempt, sets `blocked_until` through the pacer, and parks the chunk until its `Retry-After`. The third in a row on one chunk fails the run with 429.
- A **retryable failure** on attempt 1 parks the chunk for 5 s (`RETRYABLE_PARK_MS`). A provider error is spaced by the slot ledger anyway; a failure before any slot was reserved, such as a database read failing, is not, and an instant retry would spend the last attempt on the same blip. An error that is not a `SummarizationError` counts as retryable.
- **Attempt 2 failing, or a non-retryable error**, fails the run with that error's status.
- **More than two claims of one chunk with no answer** fail the run without another provider call. That covers a step that keeps getting killed. Planning and finalizing get the same bound, `MAX_STEP_ATTEMPTS` (3) claims in a row.
- **A stored result that fails its read-back check** reads as missing, so the chunk is claimed with `claim_step(p_redo)`, which clears the result. Without it the claim saw a result and refused the chunk as done, and the run asked for that chunk forever.

**The extraction summarizer** (`useStepSummarizer`) makes one attempt and waits 0 ms for its slot. Retries are the ledger's attempts, not loops inside the request. `SummarizationError.hold` tells a slot miss (`busy`) from a provider 429 (`rate-limited`), and gives when to come back.

**Deletion and resume:**
- The 4 h `indexing` status lease is gone from `deletionBlocker` and `claimLooksStale`.
  - An `indexing` meeting with no live step can be deleted at once.
  - The progress page offers "Resume extraction" whenever it is not the page driving.
- Transcription keeps its 15-minute status lease until step 7.

**Not yet done:**
- `event.waitUntil` around the step.
- The chunk step still reads the plan's segments with one range query. Planning, however, reads the whole transcript once per run, until step 7 plans incrementally during transcription.

## Addendum: step-wise transcription as built (step 7, 2026-11-01)

`POST /api/meetings/:id/transcribe` now does one step per request (`server/utils/transcription/steps.ts`, `advanceTranscription`): the Whisper call, one page of its reply, or the last step. It answers 200 with `{ meeting }` once the meeting is past transcription, and 202 with `{ meeting, progress: { done, total, segments, lastError }, next, retryAt, retryAfterMs }` otherwise. `done` and `total` are bytes of the reply. The progress page loops on it the way it loops on summarize; step 9's `/advance` can call the same library.

**One more migration** (`20261101120000_transcription_steps.sql`):
- `append_segments(p_from_idx, p_segments, p_cursor)` stores a page and the cursor after it and ends the step, in one transaction. It deletes everything from `p_from_idx` on before inserting, rather than upserting, so a retried page replaces itself and rows of an abandoned attempt past the new end go too. It also starts the claim count afresh, so `attempts` means "of this page".
- `finish_transcription(p_chunks, p_refusal)` starts the summarization run with its plan written and moves `transcribing → summarizing`, in one transaction. With `p_refusal` it writes no plan and moves to `failed`/summarization instead.
- **Both also require the meeting to be `transcribing`**, read under the meeting's lock. A token says who holds the stage, not what the meeting has become, so this is what actually stops a finished transcript being replaced. The route's own check is only a read.
- `claim_step` gains `p_expected_updated_at`, and a retry out of `failed` passes the `updatedAt` it read. The status alone does not say which failure it is or how recent: without this, a stale retry could reopen a meeting another tab had just finished to `failed`/summarization, and the next step's Whisper call would clear its transcript, or could skip a cooldown that had just restarted. `updated_at` moves with every write to the row, so it covers the failed stage too. Extraction's retry does not pass it yet.

**Differences from §2:**
- **The last page is its own step.** The page that sees the array close stores its lines like any other; the next request writes the plan, moves the status and deletes the reply. One more Worker request per meeting, in exchange for one shape of page and one function per job.
- **A page reads 64 KB and stores at most `SEGMENTS_PER_PAGE` (100).** The scanner finds the top-level `segments` key byte by byte, through a transcript `text` field that can span many pages, keeping its state in the cursor. A key-shaped string in the text, or `segments` nested under another field, is not the array.
- **A segment bigger than the window** doubles the window for that page, up to `MAX_PAGE_BYTES` (1 MiB); past that the run fails.
- **The sort is per page, not per reply.** `normalizeSegments` still sorts, but only within a page: a whole-reply sort is what bounded work gives up. The player's `findActiveSegment` binary-searches `startMs`, so order across pages is kept by moving a line that started before the last page's last line up to that line's start (`lastStartMs` in the cursor), with its end clamped to match. That shifts a timestamp rather than reorders lines. Whether Whisper ever does this on a real reply is not known.
- **A line AHEAD of the rest is different**, because the floor only rises: unchecked, one wrong start would carry every later line up to it, past the end of the audio if that is where it pointed. `containOutliers` runs first, in the reply's own order: a line outside the page's longest run in time order and later than the kept line before it, or starting past the reply's `duration` plus 1 s, moves back to that kept line as zero-length. `duration` comes from the reply's first 512 bytes (`replyDuration`), since the reply is never parsed whole, and goes in the cursor; a reply that does not say there simply has no such bound. What is left: a last line on a page has no later line to show it is wrong, so inside the audio, or with no `duration`, it still raises the floor until the real times catch up.
- **The end of the reply is not parsed.** Reading stops at the closing bracket of `segments`, so damage after it goes unnoticed. Nothing after it is used.
- **The 200 no longer carries `segments`.** Reading the transcript back would grow the last step with the meeting. The page reads `GET .../transcript`, which it already did.
- **Subrequests** are more than the table says, chiefly the meeting reads either side of a step: Whisper 8–9 (~6 in the table), a page 6 (3–5), the last step 6 (5). All constant.

**How the plan reaches extraction.** The cursor carries `{ count, chunks, open }`. `chunks` stops growing at `MAX_CHUNKS` while `count` carries on, so the cursor stays small however long the meeting. `advanceExtraction` uses a stored plan from `summarizing` only if no chunk has a result yet, since the first chunk's claim leaves that status; otherwise it plans from the transcript as before. So the whole-transcript read in `plan` now happens only for a silent recording, a meeting transcribed before this step, a repair of `ready`, and a retry of `failed`/summarization.

**`MAX_CHUNKS`.** Over the limit, the transcript stays, the meeting goes to `failed`/summarization and the route answers **200**, because transcription did finish. A retry at the summarize route then answers 413 as before.

**The raw reply:**
- It lives at one key per meeting, `meetings/<id>/whisper-reply.json` (`whisperReplyKey`). Derived from the id like the audio's key, so the delete path can always name it even when the row is gone, and a repeat attempt replaces the last one rather than leaving another behind. It is removed after the last step, best effort; the delete path and the lifecycle rule remove one that stays.
- R2 has no write fence, so a Whisper step that outlives its lease can still overwrite the reply of the step that re-claimed it. The cursor therefore records the size and validator from the put, and a page finding anything else fails the run rather than stitching two replies into one transcript.
- The same step can store its reply after the meeting was deleted or its transcript finished. It finds that out when its write is refused, and removes the object then, but only in those two cases: while the meeting is still being transcribed another step may be reading it.
- `stored_audio_bytes` and `audioIsStored` are untouched and do not count it, as above.
- A reply that is gone, changed or malformed clears the cursor and fails the run, so the retry after the cooldown calls Whisper again. It never re-sends by itself: that spends quota, and the same reply may come back. Nothing will read that object again, so the same step removes it, best effort. A page that only kept being killed keeps its reply and its cursor.
- **A reply the transcript table cannot hold** is handled before the database sees it, because a refused page would otherwise keep its cursor and fail the same way on every retry. `normalizeSegments` drops a NUL and replaces a lone surrogate, keeping the line; a timestamp past `start_ms`'s integer that `containOutliers` did not catch counts as malformed. `assertValidPage` refuses all of these in both drivers, as Postgres does.

**Failures:**
- **429:** `failed`/transcription as before, with `run.retryAt` from `Retry-After`, so the cooldown is `max(updatedAt + 60 s, retryAt)`. A 429 with no header assumes 60 s (`retryAfterMs`, shared with extraction); the stub sends none. The block goes to `note_rate_limit('groq-whisper')`, and a Whisper step reads `blockedUntil` before sending, parking without spending an attempt. The parked step's reason goes on the run as `lastError` (`PROVIDER_BLOCKED_ERROR`), so the page can say why it is waiting and for how long, on a meeting that never saw the 429 itself. No slot is reserved, as §4 says.
- **Retryable failures now park, where the old route reset to `uploaded`.** The ADR was silent; this follows the chunk rule. Attempt 1 parks for 5 s and attempt 2 fails to `failed`/transcription. The reset was the one transition with no attempt limit and no cooldown, and writing it under the token would have needed another function. A parked run's error is on the run, not the meeting, so the page's "The last attempt did not finish" alert now shows only for a row the old route left in `uploaded` with an error.
- **Claims:** Whisper at most `MAX_WHISPER_ATTEMPTS` (2), so a step that keeps being killed cannot keep spending audio quota. A page or the last step, `MAX_STEP_ATTEMPTS` (3). A retry out of `failed` resumes from the cursor, so a failed page does not spend Whisper again.
- **Truncated or non-JSON replies** used to count as retryable and reset to `uploaded`. They are now seen a page later, after the reply is stored, and fail the run with the cooldown.

**The status lease is gone.** `TRANSCRIBE_CLAIM_LEASE_MS`, `IN_FLIGHT_LEASE` and `claimLooksStale` are removed: with `indexing` out at step 6 nothing was left in them. `deletionBlocker` reads only the upload window and step leases, so a paused `transcribing` meeting can be deleted at once. The page's "Resume" is offered whenever a meeting is `transcribing` or `indexing`, and the server answers `wait` if a step is live, so the page no longer needs the lease or its wall-clock poll.

**Not done, or unverified:**
- **The multipart body uses `FormData`, not `FixedLengthStream`.** The fixed-length path needs a real Groq request to verify and was not attempted. So the exception under Consequences stands: this step's CPU grows with the audio, up to 25 MB, and is unmeasured.
- **CPU per step is unmeasured**, as for every step until Phase 13.
- **`event.waitUntil` around the step** is still not done.
- **Nothing here has run against real services.** The new `test:services` cases (the two functions through `advanceTranscription`; a PUT and a range read reporting the same R2 validator) were not run, because the migration has not been applied. The R2 validator check matters most: if a PUT's ETag and a range read's differed beyond their quotes, every page would fail. `sameBytes` ignores quotes, and the case exists to catch anything else.
- **No real Whisper reply has been through the scanner.** The fixtures follow Groq's documented segment fields and the envelope the old route's schema accepted.
- **`TranscriptRepository.replaceForMeeting` still exists**, with no caller left in production code. Specs and `test:services` seed with it, and removing it was left out of this step.
- **A transcript is partly visible while it is written.** `GET .../transcript` returns the rows so far during `transcribing`, and after a failed attempt until the retry's Whisper step clears them. The meeting page says so above the lines, and sends the reader to the progress page, the only thing that moves the run until step 11, and the only thing that moves it quickly since. The "Transcribed" tick still waits for the status.

## Addendum: step-wise indexing as built (step 8, 2026-11-02)

`POST /api/meetings/:id/search-index` now does one step per request (`server/utils/qa/steps.ts`, `advanceIndexing`): one batch of windows, or the last step that marks the index complete. It answers 200 with `{ index }` once it is complete, and 202 with `{ progress: { done, total, lastError }, next, retryAt, retryAfterMs }` otherwise. `done` is windows of the plan dealt with, embedded or found stored; `total` is null until the run reaches the plan's end, which is the first it is known. The progress page loops on it the way it loops on the other two, showing the count the status route read before it started; step 9's `/advance` can call the same library.

**One more migration** (`20261103120000_search_index_steps.sql`, safe to run twice, which `verify-migrations.sh` does):
- `meeting_index_state`, as §3 has it. `window_count` is 0 until the run finishes.
- `transcript_hash` is a SHA-256 over every line's index, times and text, in Postgres, using the core `sha256`. This is what `text_hash` holds. A Worker noticing a replaced transcript reads one short string, not the lines.
- `read_index_state(p_meeting, p_model)` answers the marker, the hash now, and how many lines and windows there are, in one row, marker or not.
- `upsert_windows` stores a batch and the cursor after it, marks the index incomplete and ends the step, in one transaction under the token, in the order that means a question is refused before any window of an old index is replaced.
- `finish_index` marks it complete. It answers `complete`, `lost` (the token is not live) or `changed`, and writes nothing unless the transcript still hashes to what this run planned, every planned window is stored under this model, and the last one reaches the transcript's last line. A plan cut short, or a hole, cannot be called complete. It is also the only thing that removes windows during a run, and only those past the plan's end.

The whole-transcript hash runs in Postgres on every status read and question. That is a few hundred kilobytes at most (`MAX_AUDIO_BYTES` bounds the transcript), one subrequest, and no Worker CPU; it was chosen over a chain of window hashes in the cursor, which could not notice a replaced transcript without planning it again.

**A slice is the same plan.** `planWindows` and `planWindowSlice` are one forward scan, `scanWindows`. A window that reaches the last row read is not settled unless the page is known to end the transcript, even when its span has already closed it, because whether another window follows depends on that row being the last. The next page starts over at that window's first line. `listFrom` takes "is there more" from the store's own count, not from a short page, since a server row cap shortens a page without saying so. `tests/unit/qa-windows.spec.ts` drives this loop over 60 seeded transcripts holding what a transcript awkwardly can (over-budget lines, zero-length lines, overlaps, gaps in the numbering, no-space scripts), each cut seven ways, and 20 more under other targets and budgets, and requires the result to equal `planWindows`, hash for hash. Every page size around one transcript's own length is tried too, since a page ending exactly where the transcript does is the case a slice cannot see from inside.

**One step, first match wins, and at most one provider request:**
1. A finished index for this transcript and model: done, with no claim.
2. A live lease: `wait`, at the earlier of the lease's end and 2 s.
3. Parked until the daily limit resets: the same 429 again, with no claim. Parked for anything shorter: `wait`.
4. Otherwise claim, in whatever status the meeting is in, and do what the cursor says. A cursor for another transcript or model starts the plan over, which re-embeds only what no longer matches.

A batch reads a page of `INDEX_PAGE_SEGMENTS` (256) lines, hashes at most `INDEX_BATCH` (16) windows and reads their keys by range. The ones not stored go through `planEmbeddingBatches`, the same split the driver applies, so the batch is within both 16 windows and `MAX_BATCH_TOKENS` and is one request; a window that did not fit is where the next step starts. A window too long for the page doubles the page for one step, up to `MAX_INDEX_PAGE_SEGMENTS` (1,000), and past that the run stops with a 422: every line with text costs at least 5 tokens, so a window closes within about 300 lines.

The step's embedder makes one attempt (`useStepEmbedder`), as extraction's summarizer does. **Subrequests:** 9 for a batch (the table says ~6, not counting the reads either side of a step, as step 7 also found), 10 for a pass's first batch, which reads the state again under its claim, since a finished run also leaves no pass and a driver holding an older read must not start one over it, 5 for the last step, 2 to answer for a finished index, the same on any length of meeting. Questions rise to at most 10 from ~7, since up to four retrieved stretches are read separately.

**The marker decides, not what happens to be stored:**
- **Ready** means a complete marker for this model, the transcript hashing as the marker says, and exactly `window_count` windows stored, all under this model (`readyWindowCount`). The status route and a question both go by this. A transcript with no lines and nothing stored is ready with none, as before.
- **A meeting indexed by older code** has windows and no marker. It reads `incomplete`, whatever is stored. A question is refused, and the next run finds every window stored, spends nothing, and writes the marker.
- **Another model's windows** read as not this model's: `none` or `incomplete`, as before.
- **A question** reads the marker, then its slot, the embedding and the search, then only the lines of what it retrieved, and hashes each window from those lines. That replaces both whole-transcript reads ask used to make, including the check that a window retrieved after a replacement is refused.
- **`GET .../search-index`** answers a finished index from the marker. Any other state still plans the whole transcript and reads every key, to say "8 of 12" and `none` from `incomplete`, as it did on every read before. That is the one read here that still grows with the meeting. It is not a step, and it happens when a page asks about a meeting that is not ready.

**The other-model hazard is narrower, and not gone.** `indexMeeting` deleted all of a meeting's windows in one request when the model differed, and `deleteExcept` is removed with it. Windows are now replaced in place, up to 16 per request, and nothing else is removed until the plan's end. So one request under the wrong model overwrites at most 16 windows, not all of them, and restoring the right model re-embeds only those. But the first such write still takes the marker to incomplete, so questions stop at that moment until someone indexes again, and a driver that keeps going still replaces every window. A deployment that has lost its Workers AI settings falls back to the stub, which is exactly such a model, and that guard is not part of this step. Nothing here starts indexing without a click. **Step 10's client driver must not change that before the guard exists:** a page that indexes when it opens would make simply viewing a meeting enough to reach this.

**Quota:**
- **A slot of its own,** `workers-ai-embed`, at `NUXT_EMBED_INTERVAL_MS` (1 s) with no wait. It is only read for a step that has something to embed, so a run finishing stored windows passes through a block.
- **At the daily limit** the provider's refusal notes a block until 00:00 UTC on the slot, and parks the run on `retry_at` until then with the attempt refunded, keeping what is stored. The visitor gets the existing 429 and its sentence, and gets it again for free for as long as they ask: no claim, no write, no request. Waiting hours is not something for a page to sit through, so unlike a parked extraction this does not answer `wait`. Another meeting finding the block parks the same way without sending anything. A refusal in the first 5 minutes after 00:00 UTC (`DAILY_RESET_MARGIN_MS`) parks only to the end of those minutes: it is a reply that crossed midnight or a clock slightly off, and the next day's date would stop every meeting for a day after the allowance came back.
- **The block is the whole account's, and rests on a classification nobody has seen.** ADR-0014 reads any 429 as the daily limit, since telling them apart takes spending the allowance. Until now a wrong guess cost one refused click. Now it stops indexing for every meeting until 00:00 UTC. Clearing `provider_slots.blocked_until` and the run's `retry_at` undoes it by hand.
- **Questions do not read that block**, and do not set it. The provider's own refusal is the authority for each question, and a wrong guess above should not also take questions away for a day. The cost: while the allowance really is gone, each question spends a Groq slot before it is refused, since ADR-0015 takes the slot before the embedding.

**Failures never touch the meeting**, in every status it can be indexed from:
- A **retryable failure,** a provider 5xx or a database blip, parks for 5 s on attempt 1 (`RETRYABLE_PARK_MS`). On attempt 2 the run parks for 60 s (`RETRY_COOLDOWN_MS`) and the caller is told. There is no `failed` to go to, so that park and the count from it (`parkedAtAttempt` in the cursor) are what stop a step that keeps dying from spending quota: at most `MAX_INDEX_ATTEMPTS` (2) requests, then a minute.
  A failure that is not the provider's reaches the caller and the run as one plain sentence, and the error itself goes to the log, since a database's can name its tables. Steps 6 and 7 still pass theirs on as they are.
- A **refusal** (over capacity, rejected credentials, a passage over the limit) goes back to the caller with the attempt refunded and nothing parked. Only a passage over the limit is said not to help by trying again.
- A **last step that finds things do not add up** starts the plan over, at most `MAX_INDEX_RESTARTS` (2) times in a row, then parks.

**Deletion:** `indexingInFlight` is gone, with its wait after the row's removal. `deletionBlocker` reads the lease like any other stage's; a parked run is deletable at once however long its park, and the cascade takes the marker, windows and run. On the local driver, which has no foreign key, the fence reads the row as well as the token, and that is what now keeps a straggler from writing windows back.

**Not done, or unverified:**
- **CPU is unmeasured, and this is the step most likely to need its setting changed.** `INDEX_BATCH` of 16 has to be measured on real Workers CPU, which nobody can do until Phase 13. Locally (Node 24.18, Apple M5), through the real Supabase and Workers AI drivers with `fetch` stubbed, a whole step of 256 lines and 16 windows took a median of 4.6 ms of CPU, 5.6 ms at most once warm, and 23 ms as the first call in a fresh process, with a 360,804-byte upsert. The stubs' own building of a reply is included, so that overstates it some. ADR-0014 notes a Worker may be several times slower, which on those numbers does not leave 10 ms clear. If it measures over, `INDEX_BATCH` shrinks and nothing else changes.
- **Nothing here has run against the real project.** `test:services` has two new cases for the SQL through the real drivers, which **cannot pass until `20261103120000_search_index_steps.sql` is applied.** They were run against the migrations on a throwaway Postgres with PostgREST in front, where they pass, along with step 7's. That is not Supabase: its grants and its row cap were stood in for by hand.
- **A real 429 at the daily limit** has still not been seen, as in ADR-0014.
- **Indexing moves `meetings.updated_at`,** since every claim does (§3). On a meeting whose extraction failed, that restarts the 60 s before extraction may be retried, for as long as indexing runs.
- **`event.waitUntil` around the step** is still not done.
- **`TranscriptIndexRepository.upsertWindows` still exists,** unfenced, with no caller left in production code. Specs and `test:services` seed with it, as with step 7's `replaceForMeeting`.
- **A batch with an oversize window is refused whole,** so the other windows in it wait too. That was already so, and the meeting stays without questions either way.

## Addendum: `/advance` and `/pipeline` as built (step 9, 2026-11-03)

`POST /api/meetings/:id/advance` takes the one runnable step, the same library each per-stage route calls (`server/utils/pipeline/advance.ts`), and answers 200 with where that leaves the meeting. `GET /api/meetings/:id/pipeline` answers the same from the same pure function, `assessPipeline` (`server/utils/pipeline/assess.ts`), without taking the step. What a step returned is not passed on: after it runs the stored state is read again and assessed, so a driver is told what is stored whether this request took the step, lost the claim or hit a failure. **No migration.** The per-stage routes were already one step each and keep their contracts; they now build their dependencies in one place (`server/utils/pipeline/deps.ts`) with `/advance`.

**The answer** is `{ status, progress: { stage, done, total, etaSeconds }, index: { state, done, total, retryAt }, next, retryAt, retryAfterMs }`. `retryAfterMs` is there for the reason it is on the other routes. `index` is added to §1's shape, because the index moves independently of the stage and step 10 has to say why questions are off. Neither route says why anything failed, and neither carries a model, token, run id or cursor: `errorMessage` and `lastError` can hold a provider's or a database's own words (see below). Anything unexpected is a 500 in one plain sentence, with the cause in the log. An unknown meeting answers 404 as the others do.

**How §2's table reads from stored state:**

| Row | Taken when |
| --- | --- |
| 1 | `failed` for transcription or extraction, not permanent, and `cooldownEnds` has passed. Transcription first; only one of the two can be true |
| 2 | `uploaded`, or `transcribing` with no live lease or future `retryAt` |
| 3 | `summarizing` or `indexing`, no live lease or future `retryAt` on the run, and a chunk without a result, or no plan yet |
| 4 | A finished transcript, the index not complete, nothing here barred from it (below), no live lease or future `retryAt`, and not stopped |
| 5 | `indexing`, every chunk with a result, and row 4 does not apply |
| 6 | The earliest of whatever is in flight or parked for at most `LONGEST_INDEX_WAIT_MS` (the index) or any time (the others) |

"A slot is free now" (row 3) is not checked ahead of the step, which would cost a request on every step. A slot miss parks the chunk on `run.retryAt` as step 6 does, costing one request per gap, and then no reads at all until that time. So row 4 runs in the gap, and the answer to the slot miss itself is `continue` if a batch can go. Row 5 after row 4 means the status stays `indexing` until the index is complete or cannot move, as §2 has it.

**`next` is `continue` only when a row above matched**, so a later call has a step to take. The unit spec checks across each provider failing each way for ever that the call after every `continue` changes what is stored.

**The public demo is the exception that is not a row.** Its `/advance` is always a 403 (ADR-0015), and the table cannot see that, since it reads only what is stored. So `GET .../pipeline` on the demo's id takes the assessed answer and removes what no caller there could act on (`withNoStepOnOffer`): `continue` becomes `wait` with no `retryAt`, as on a `pending_upload`, and a `failed` or `done` loses its time to come back. A `wait` with a time stays, being a step already under way, and `index` still says how it stands, so `building` can be read beside a `wait` that nobody will end. Step 10 should not drive on `wait` with no `retryAt`; it looks again slowly or not at all.

**Termination.** A driver stops at `done` and `failed`, and these are what stop it:
- **`failed` is answered at once and retried only by the next driver to ask.** §2's row 6 could be read as waiting out a failure's cooldown and retrying for as long as a tab is open. That would be unbounded and would keep spending quota, so a failure stops the driver, with `retryAt` saying when a retry is allowed. A request after that retries (row 1), once per request that gets that far. While there is index work, the answer is `continue` or `wait` rather than `failed`: an extraction failure does not stop the index.
- **Permanent failures are not retried at all, and take no claim or write:** a rejected upload, a transcript over `MAX_CHUNKS` (`refusedAsTooLong`), and audio gone from storage or changed in it (`audioIsGone`). These are read from the stored message, which is all a failed row keeps, so `retryAt` is null. The explicit routes still try if asked, which is how a meeting whose object an operator put back gets going.
- **A recording with no speech** plans nothing, finalizes, has nothing to index, and answers `done`.
- **An index that keeps failing stops itself.** Under `/advance` (`advanceIndexing`'s `unattended`), a run out of attempts, a refusal, or a pass that keeps not adding up parks for `UNATTENDED_PARK_MS` (15 min), past the longest wait, instead of 60 s or not at all, so it ends in `done` with a `retryAt`, and the next driver after that tries once more. A passage over the model's limit, or a refusal an explicit request got, parks for nothing and answers `index.state: 'stopped'` until an explicit POST.
- **Waiting on a slot has no bound in requests**, only in time. It is always `wait`, never `continue`, and the driver's own bound is what a client has to choose. `driveToDone` takes 200.

**Decisions to reverse if they turn out wrong:**
- **An index parked past `LONGEST_INDEX_WAIT_MS` (5 min, the same as `DAILY_RESET_MARGIN_MS`), with nothing else left, answers `done` with `retryAt` and `index.state: 'parked'`, on a `ready` meeting.** Not `wait`: a page sleeping until 00:00 UTC is mostly a page that has been closed. Not `failed`: the meeting has not. While transcription or extraction has work, the answer is theirs and `index.retryAt` carries the park, so nothing else is held up. A driver is told again for free for as long as it asks, and the first request after `retryAt` carries on. The shorter wait, near or just after the reset, is `wait`. The cost: `done` no longer means "the index is complete". A client has to read `index.state` or `retryAt`, which `driveToDone`'s acceptance does.
- **`/advance` stays off another model's work entirely (`unattendedMayIndex`).** It writes only with no window stored under another model, no marker of another model and no finished marker of another transcript. An incomplete pass under another model can overwrite too: `advanceIndexing` starts over from window 0 under the current model and replaces windows as it goes, losing paid-for vectors just as a complete index would, so it is held, as `index.state: 'held'`, with a `done` once nothing else is left. So is a pass under the current model with another model's windows left in it, since the only way there is an explicit request that can carry on by itself. So is a pass of another model with no marker or windows left to show for it, which only a marker and windows removed by hand leave: the step refuses to take it over, so answering `continue` would never end. **SEC-16's guard itself is still not built;** this keeps `/advance` from widening it. The cost: after a real change of model, or a stub period, each such meeting stays as it is until someone POSTs `.../search-index`, and a rebuild whose tab closed waits for the same. Questions are refused in the meantime, as they were.
- **`/advance` does not repair a `ready` meeting with no summary row.** That takes a new run, spends Groq quota, and would need the summary read on every request to `ready` meetings. `POST .../summarize` still does it.
- **`pending_upload` is a 409 from `/advance`,** the transcribe route's refusal, since no step of a driver's can confirm an upload. A read answers `wait` with no time, as a passive tab may look again.
- **Extraction and transcription still `wait` however long a provider's block lasts,** up to a day (`MAX_RATE_LIMIT_BLOCK_MS`). §1 says the browser waits, and the meeting is not readable yet the way it is with only its index parked. Step 10's pause banner has to cover this.

**Honest figures.**
- **`status`, `done` and `total` are read from the row, the run's cursor, the chunk counts and the marker.** `stage` is the earliest unfinished stage, so it only moves forward, including while an index batch runs in a gap. `done` falls only when the work really started over: a lost reply clearing the cursor, a replaced transcript, a redo of a chunk whose stored result failed its check. `index.total` is null until the plan's end has been reached.
- **`etaSeconds` is always null.** The only stored figure to work from is chunks left times the interval, and that is a floor: the slot is shared with questions and other meetings, a 429 adds whatever the provider says, Whisper's time is unknown, and an index has no total until it ends. A floor shown as an estimate would run backwards whenever a question took a slot. `retryAt` is the honest number for the next wait.

**Subrequests.** Read before a step: at most 5 (the meeting, its runs, the index state, and two HEADs for the chunk counts while extraction is in progress; `read_index_state` hashes in Postgres, so its answer stays one short row). The same again after it. **The worst case is 27 of 50**, counting R2 and the provider: the first chunk of a stored plan whose step loses its claim while out at the provider, as a named test pins by adding up what each repository method costs on the real drivers. A request with no step is at most 5 and writes nothing, and so is `GET .../pipeline`. At most one claim and one provider request per request. None of that grows with the meeting, with one exception from step 6: planning from the whole transcript is 20 requests plus one per 1,000 lines. Only a retry of `failed`/summarization with no plan, a silent recording, or a meeting transcribed before step 7 gets there, and `MAX_AUDIO_BYTES` holds a transcript to about 3,000 lines at the measured rate, so 23. `countChunks` was added so that choosing a step reads no chunk's result, since `listChunks` returns all of them; extraction's own step still does, as step 6 left it, with up to `MAX_CHUNKS` rows, so that reply is the part of a chunk step that grows, up to that bound.

**Concurrency and deletion** are the steps' own. Each stage has its own claim, so a second driver can take an index batch while the first is out on a chunk, and a lost claim is simply reassessed: `continue` or `wait`, never `failed`. A failed extraction's retry now passes `expectedUpdatedAt`, as transcription's has since step 7, because an index claim moves `updated_at`. A live step blocks a delete as any other does, a parked run is deletable at once, and a meeting deleted during a step answers 404 with nothing written back.

**Not done, or unverified:**
- **CPU is unmeasured, as for every step until Phase 13.** Nothing here claims a figure for Workers. Reading and assessing adds a few small JSON parses to each step, and a request can now hold two of those reads around the step.
- **Nothing here has run against the real project or a real provider,** and `test:services` was not run, since the real database lacks step 8's migration. No provider code changed. `countChunks` has an assertion in the run-ledger `test:services` case that has not yet run. A spec that is not committed drove the real Supabase drivers, with scripted providers and the local audio store, over the migrations on a throwaway Postgres with PostgREST 12.2.3 in front, where everything here passes: uploaded to ready, `countChunks`'s two HEADs, a read sending nothing but reads, a retry through the `updated_at` fence, the daily limit, another model's index left alone, two drivers at once, a transcript over the limit and a delete during a step. It also held the test table of subrequests to the requests actually sent on a whole drive, and found the table right. That is not Supabase: its grants were stood in for by hand, and neither R2 nor a real provider was involved.
- **Steps 6 and 7 still store and answer raw errors.** `advanceExtraction` and `advanceTranscription` put `err.message` in `errorMessage` and `lastError`, and `GET /api/meetings/:id`, `POST .../transcribe` and `POST .../summarize` return those. `/advance` causes those writes like any other caller, and its own answer carries neither, so step 10 needs a safe sentence if it wants to show why.
- **`/advance` under missing credentials transcribes and summarizes with the stubs, unasked,** and a finished transcript is never replaced. It is a click today, on either route, and nothing calls `/advance` by itself yet. **Step 10 turns it into opening a page, so SEC-16's guard has to come before step 10**, as step 8's addendum already says for the index, or step 10 has to hold back on anything but `index.state`.
- **An explicit `POST .../search-index` honours a park `/advance` set,** and answers `wait` for up to 15 min. The current page would sleep through it, but nothing calls `/advance` from a page yet. Step 10 has to offer that retry differently.
- **Indexing moves `meetings.updated_at`** (step 8's note). A failed extraction's cooldown therefore restarts with each index claim, so its `retryAt` moves out while the index runs. Bounded by the index's length, and honest, since the figure read is the stored one.
- **`event.waitUntil` around the step** is still not done.

## Addendum: the client driver as built (step 10, 2026-11-03)

Opening `/meetings/:id/progress` now takes a meeting from `uploaded` to `ready` with no click. The per-stage buttons and the page's own loops are gone. The logic is `app/utils/pipeline-driver.ts`, which is handed its clock, timers, `fetch` and lock manager, so all of it runs in a test in fake time. `app/utils/pipeline-view.ts` is every sentence the page says, as plain functions of the driver's state. `usePipelineDriver` gives the first a browser and starts it in `onMounted`, so no lock or timer code runs on the server, and a server's render moves nothing. **No migration, and no change to what `/advance` or `/pipeline` answer.**

**What an answer does:**

| Answer | The driving tab | A watching tab |
| --- | --- | --- |
| `continue` | Asks again at once, up to the spin bound below | Looks again in 5 s |
| `continue` on a `failed` meeting with `index.state` not `building` | Stops, and offers the retry: the only step on offer is the retry, and that takes a click | Same |
| `wait` with a time | Sleeps `retryAfterMs` plus 0–2 s, at least 1 s, at most 5 min at a time, and asks again | Looks in 5 s, or in 1 min if the wait is 2 min or more |
| `wait` with no time | Sends no step. Looks with `GET .../pipeline` once a minute, and drives if that changes | Looks once a minute |
| `done` | Stops and gives up the lock. Reads `index.state` for what to say | Stops and leaves the queue |
| `failed` | Stops, whatever its `retryAt`. A retry is offered from then, and with none, not at all | Same |

**It reads first.** Every driver starts with `GET .../pipeline` and only then sends a step, on opening, on taking over the lock, and on a retry. So a finished meeting's page sends no POST, and neither does a `pending_upload`'s, which could only answer 409, or a tab taking over from one that just finished. It costs one read per start, at most 5 subrequests.

**Decisions to reverse if they turn out wrong:**
- **A retry takes a click, including on opening the page.** Step 9 lets "the next driver to ask" retry, and that could have been opening the link. It is not, because that retry can spend quota, and a page reloaded every minute would then spend it every minute. The cost: reopening a failed meeting does nothing until someone presses the button. There is one way past this: a failed extraction with `index.state: 'building'` keeps driving, as step 9 says it should, and once the cooldown is over the server's row 1 takes the retry instead of the batch. The answer does not say which it would be, and nothing here changes the route.
- **A parked index does not hold a page open.** `done` with a parked index stops, and the page offers "Carry on indexing" from `retryAt` on, which calls `/advance`. It does not offer `POST .../search-index`, which honours the park and answers `wait` for up to 15 minutes, and it does not run a timer to resume at midnight in a tab nobody is looking at. A tab coming back into view after `retryAt` does carry on by itself, as opening the page does.
- **A tab stopped on a failure or a park keeps looking, once a minute, for 26 h.** Another tab can press the retry and then close, and a window left in view hears of neither, so without this the meeting would stop with a stale failure on the screen. It takes part again when a step has been taken: the same figures as before, without `index.state`, have changed. A park running out changes none of those, so this resumes nothing at midnight, and a cooldown running out spends no retry. The cost is up to 1,560 reads for a tab forgotten on a stopped meeting, at most 5 subrequests each. A failure no retry can help, and a meeting that is done, look at nothing.
- **The Questions card still has one explicit action,** because step 9 says only `POST .../search-index` can move an index that is `held` or `stopped`: "Rebuild the index" and "Try indexing again". Offering a rebuild spends quota and overwrites stored vectors, which the card says. The route's own refusal is shown only if it says `statusMessage: 'Indexing failed'`, as that route writes its messages for visitors; anything else gets a sentence of this page's. A tab that only watches is not offered either, and a tab that asks and finds the lock taken says so and drops the request, rather than sending it whenever that lock comes to it.
- **A step already out when the page goes away is left to finish.** Aborting it would hang up on a Worker, which kills the step, and its lease (up to ~7 min for Whisper) then has to run out. Its answer is not read, and nothing follows it. A read is aborted. This is why "leaving stops requests" means no new ones.
- **`LONG_WAIT_MS` (2 min) is how the page tells a provider's block from pacing.** The answer carries no reason, on purpose. A slot is at most a minute off and a retryable park 5 s, so for transcription and extraction a wait of 2 min or more can only be a 429's block, and the banner says the provider's quota is used up for now. That is an inference, not something the server said. It does not hold for the index: the last 5 min of a 15-minute park (`UNATTENDED_PARK_MS`), after a database blip or attempts running out, is a `wait` as well. So when the wait is the index's, and it is when the meeting is `ready` or `failed` or the answer's `retryAt` is `index.retryAt`, the banner says the quota may be used up or a run kept stopping.
- **`index.retryAt` within a minute of 00:00 UTC is read as the daily limit.** Parked has two causes and the answer does not say which. Not exactly on it, because only the meeting that hit the limit stores midnight itself: any other parks on the account's block, which `note_rate_limit` works out from a duration, and which lands a round trip and any clock skew away. A 15-minute park landing in that window would be called the daily limit, and be wrong for up to 15 minutes.

**How it cannot spin, and how it cannot hammer:**
- **A `continue` showing nothing new** counts. "New" is a state of the figures this tab has not seen before, so A, B, A, B is not progress. 10 in a row (`MAX_IDLE_CONTINUES`) pauses for 30 s; the third time it stops and offers "Try again": at most 30 requests with nothing moving, per tab. A tab stopping for this gives up the lock, and the next one queued starts its own count, since its first read cannot tell. Three tabs on a server that keeps saying `continue` send about 90, a known and accepted cost: it needs a server bug and several tabs, it is paced and it ends, and each stage's attempt limits bound what a provider is asked. Sharing the stop between tabs would also stop the one case that is legitimate, a long pass over an index that has started over, from carrying on with no click. A wait between them starts the count over, since the wait is itself the pacing. A step legitimately moves no figure about five times at most: a segment bigger than its window, doubling. A pass over an index that has started over walks figures it has already seen, so past 10 batches it pauses, and a long one could stop and need the button. Only `/advance` answers count.
- **A wait** goes by the server's duration, not `retryAt` against this browser's clock, and uses `retryAt` only if there is nothing else. It sleeps at least `SHORTEST_WAIT_MS` (1 s), so one already past cannot loop. It sleeps at most `LONGEST_SLEEP_MS` (5 min), and asks again: a request with no step takes no claim, so a day's block is 288 free requests, and a block that ended early or a clock that was wrong cannot strand the tab. The countdown stays on the time the server said, not on that next look. 26 h with nothing new stops it, since a block lasts a day at most.
- **A hidden tab** needs nothing special. A timer that fires late just asks again. Coming back into view ends a sleep whose time has passed, and a stopped tab looks once, if it has not asked for 30 s. A step's own `await` is not a timer and is not throttled.

**What is not an answer:**

| Reply | What it does |
| --- | --- |
| A network error, or no reply in 8 min (30 s for a read) | Not a failure of the meeting. Backs off 5, 15, 45, then 60 s, for as long as it lasts, with no click needed. The `online` event ends this wait. A minute apart, it costs nothing |
| 500, other 5xx or 4xx, a 200 of another shape | Backs off the same, at most 4 retries, then stops with "Try again". None of its words are kept |
| 503 from the gate (ADR-0016) | The same, and it says MeetMind is not available |
| 429 | The same, and it says the server asked it to slow down |
| `Retry-After` or `retryAfterMs` on any of those | Never sooner than that, up to an hour: not the next try, not the "Try again" of a stop, and not a tab coming back into view. The `online` event ends only the wait of a network error. Only a click on rebuilding goes against it |
| 403 with the demo guard's own message | The page is read-only from then on, as below, with no more steps |
| Any other 403 | Trouble, like a 500: it comes from something in front of the app, and says nothing about the meeting |
| 404 | Says the meeting no longer exists, with no retry |
| 409 | Sends no more steps. Looks after 1–3 s, and then as for `wait` with no time |

A watching tab backs off the same way and never stops for trouble, since it spends nothing. A tab taking the lock starts its own count, so one taking over during an outage gets its 4 retries.

**One driving tab per browser.** `navigator.locks` with the name `meeting:<id>`. A tab asks with `ifAvailable`, because a request cannot have both that and a `signal`, and if the lock is taken it queues with a `signal` and watches in the meantime. The lock goes with the tab, so closing the driving tab hands over in milliseconds (56 ms in the browser job). Stopping gives it up. After `done` or `failed`, each tab queued behind reads, sees the same answer and stops, sending no step. After a stop for trouble or for the spin bound, the answer does not say so, so the next tab drives with its own bounds. A watching tab that reads `done` or `failed` leaves the queue. A tab suspended with the lock keeps it, as the browser does not take it back, so a watching tab that reads `continue` with the same figures for 5 min (`WATCH_STALL_MS`) takes it with `steal`. A driver alive through that goes back to watching and ignores any step it had out. Whether a real browser suspends a tab holding a lock was not measured, only what this does if one does. Two browsers both drive, which the server's claim makes safe: the second is told `wait` while a step is live.

**With no `navigator.locks`** (plain http, or an old browser) there is a choice. Letting every tab drive is safe, and would double the requests for as long as both are open, each mostly hearing `wait`. Refusing to drive would leave the page doing nothing over http. So `softLocks` stands in: a lease in `localStorage`, implementing the same small interface, renewed every 20 s and removed on the way out, and only the driving tab has one. It lasts 90 s so that a hidden tab's once-a-minute timers cannot lose it while it drives, which is also the longest a crashed tab holds up the next. Its key is a hash of the lock's name, since a meeting's id is the capability to read it. It is weaker than a lock: two tabs can both believe they won, and refused storage makes it say yes to everyone. Both only cost the requests this is here to save. A rejected `locks.request` drives with no lock, for the same reason.

**The public demo** is recognised on the client by `isDemoMeetingId`, the same check as the server's guard. Its page takes no lock, sets no timer and sends nothing unless its first read failed, in which case it reads at most 3 times, and never a step. It says it is read-only and not finished, offers no button, and a finished one shows no banner and leads on to asking. If the setting ever disagrees with the server, the guard's 403 turns the page read-only there and then. The message is a shared constant, and an e2e case holds what the route really sends to it.

**What is said, and where.**
- **The live region** has one sentence, always mounted, that depends on nothing that ticks: not the time, not bytes, not batches. Parts of extraction are the only count, each being a provider request, a minute apart. The banner, the countdown and the figures are outside it. The browser job watches it for changes during a countdown.
- **A pause is over once a step is plainly being worked on.** Whatever it said while it waited stops being said 5 s into a `POST` (`STEP_UNDER_WAY_MS`). Not on sending: a look through a long block, or a retry in an outage, comes straight back to the same pause, and the live region would say so each time.
- **The stepper** gives every state its own word and its own icon. `aria-current="step"` is on the first stage with anything going on. `prefers-reduced-motion` stills every `animate-spin` in the app, which includes the UI library's loading buttons.
- **`etaSeconds` is not shown.** The only times on the page are the ones the server said, in the visitor's own terms and clock: "2 hours 5 minutes (14:20)".
- **The hydration mismatch** was `createdAt` rendered with `toLocaleString()` on both sides. Until mounted it now reads as UTC on both, and nothing else on the page uses the time or the language until then, since `now` is 0. The browser job loads the page in `de-DE` in Auckland and fails on any hydration error.
- **`MeetingQuestions.vue`** read only the status, which cannot tell parked from held. When the index is not finished it now reads `/pipeline` as well, says which it is, and leaves the link out on the demo.

**Raw errors.** `/advance` and `/pipeline` carry none, and this page shows none. It has its own sentence for each failure, chosen by `progress.stage` and whether `retryAt` is null: a transcription or extraction that did not finish, audio missing or changed, a transcript over `MAX_CHUNKS`, a rejected upload. It strips `errorMessage` from its own `useFetch`, so the server's render and its payload do not carry it either, and an e2e case holds that. **What remains, unchanged:** `GET /api/meetings/:id` still returns `errorMessage`, so the browser still receives it on this page's client-side reads, and it is in the server's payload of `/meetings/:id` and `/meetings/:id/summary`. `POST .../transcribe` and `POST .../summarize` still return raw stored errors and `lastError`. Nothing on a page displays them now.

**Not done, or unverified:**
- **Nothing here has run against real services or a deployed Worker.** The browser job runs on a built Node server with stubs. Its stub pipeline has no real wait in it, so the long block, the short wait, the 503 and the lost connection are real browser behaviour against answers the test wrote. Every number above is unmeasured against a real provider.
- **A hidden tab's real throttling was not measured.** Playwright's Chromium does not throttle, so that is the unit spec's held-back timer. The back-forward cache is off there too: the browser job dispatches `pagehide` and `pageshow`, which tests this page's handlers and not whether a real browser restores it.
- **A tab closed mid-step still kills that step on a Worker,** and its lease has to run out, because `event.waitUntil` around the step is still not done. `keepalive` on the request might keep it going; it has not been tried.
- **A meeting with no tab open stopped until step 11**, whose addendum follows. It still stops on anything but a deployed Worker.
- **A real `Retry-After` on these routes has not been seen.** Nothing on the routes sends one with a 429 or a 503 today; a rate-limit rule in front of them would.

## Addendum: the cron sweeper as built (step 11, 2026-11-03)

Every 5 minutes a Cron Trigger takes one step of one meeting, with no tab open, on the same step code `/advance` runs. **The acceptance is not met, and cannot be here: a meeting with no open tab reaching `ready` on the deployed Worker waits for Phase 13.** Nothing has been deployed. What is proven is everything short of it, under local workerd and on real SQL, listed below with what it did not prove.

**How a cron reaches the app.** Read from the installed Nitro 2.13.5, not recalled. `cloudflare_module`'s `scheduled` handler sets `globalThis.__env__` and runs the `cloudflare:scheduled` hook inside `context.waitUntil`. `server/plugins/sweeper.ts` is the one thing on that hook.
- **Not `scheduledTasks`.** `node-server`'s entry calls `startScheduleRunner()`, so the same setting would run sweeps in-process on a Node server, which must have no cron, and the dev server adds `/_nitro/tasks/:name`, an HTTP route that runs a task.
- **No route reaches a sweep,** in production or otherwise. `tests/unit/sweep-source.spec.ts` reads every file that answers a request for any mention of it; the e2e job and `scripts/verify-worker-sweep.mjs` ask `/__scheduled`, `/_nitro/tasks` and the names a route would have. Tests call functions. `wrangler dev` answers `/cdn-cgi/local/scheduled` itself, and Cloudflare documents that as local. Under `nuxt dev`, Nitro's own `/_nitro/tasks` answers with an empty list, as for any Nuxt app, since no task is defined here for it to run.

**A scheduled invocation has no request.** Everything that builds a driver takes an H3 event, for two things: `useRuntimeConfig(event)`, which applies the environment per event and keeps it at `event.context.nitro`, and the gate's `event.context.cloudflare`. `useRuntimeConfig()` with no event will not do: it is what was read when the isolate loaded, before a Worker has its settings. So `scheduledEvent` gives them exactly that, and `cloudflare: { env, context }`, what Nitro's own `runCronTasks` hands a task. It is a `Proxy` that throws on any read but `context`, so code that wanted a request fails where it reads, rather than finding `undefined` and carrying on. `driver-gate.spec.ts` walks every selector with it. Under workerd it reads `.dev.vars`, and it refuses as a Worker when one is missing, before anything is sent.

**One tick,** first match wins: choose a meeting, take its one step, stop. At most one claim and one provider call, through `advanceUnattended`, which reads what `/advance` reads and calls the same library. No second read, since nobody is waiting to hear.

**Subrequests, against 50.** A tick with nothing to do: 1. A chosen meeting with no step after all: 6. **Worst case 23,** a named test in `tests/unit/sweep.spec.ts`: `/advance`'s worst path (27, step 9), less the 5 reads after it, plus the one that chooses. Under workerd, a whole drive never passed 18. Planning from a whole transcript is 19 at most, `MAX_AUDIO_BYTES` bounding it as step 9 says. `aws4fetch` retries R2 twice on a 5xx, which the table does not count: a Whisper step is 11 and so 15 at most, under the worst case.

**Which meeting.** `sweep_next_meeting` answers in one request, and always in one row. **Migration: `20261103180000_sweeper.sql`,** which also has to be applied before this works at all.
- **What it reads:** at most 50 meetings in progress that have waited longest, and 50 finished transcripts touched most recently, each by a partial index, and the rows of those by key. Counted by Postgres in the tick's own transaction, on the six tables a tick reads: **100 rows with 5,000 finished meetings, 100 with 20,000, no scan of a whole table in either; 250 with 2,000 in progress as well, none able to move.** A table of a few hundred rows gets a scan, since that is the cheaper plan there (about 4,700 rows at 200 meetings, a fixed cost of a small table). A meeting that can move also reads its own windows, a few hundred at most, to rule out another model's, and a backlog of those is what would raise these figures. `verify-migrations.sh` holds these. So a meeting past those 50 waits for the ones ahead of it to move, or for a tab. A `ready` meeting whose index never started, with 50 others touched since, is the likeliest, and needs a tab.
- **What it picks,** `sweep_can_move`: the mirror of `unattendedStep` in `assess.ts`, as `stored_audio_bytes` mirrors `audioIsStored`. 48 cases of stored state in `tests/unit/helpers/sweep-cases.ts` hold both to one answer, on the local driver in `pnpm test` and on the real Supabase driver over real SQL in `pnpm test:postgrest`. They differ once, on purpose: a complete marker counts as settled, because telling that it no longer adds up takes hashing the transcript for each meeting looked at. A tab still finishes that one.
- **Rotation is stored,** in `sweep_state`, one row: the last meeting chosen, by when it was created and its id. Choosing moves it on, in the same transaction and before anything is done with the meeting, so a meeting that kills every invocation before its claim gets its turn and no more: the spec's stuck meeting, that fails every time, does not stop two others reaching `ready`. It holds no foreign key, so a deleted meeting does not lose the place. Two ticks at once queue on the row lock and come away with different meetings.
- **The demo** is left out by id in the SQL, and checked again before anything reads it. A setting that is not an id excludes nothing, since it names no meeting.

**Spending with nobody watching.** A free key, 288 ticks a day, and a person who has gone. Where the table in step 9 asks for a step, `unattendedStep` asks for less:

| Stored state | `/advance` | A tick |
| --- | --- | --- |
| A `failed` stage, cooled down | Retries it | **Never.** That takes a click, as step 10 made it |
| A step's own second attempt, parked | Takes it | Takes it: bounded and stored. Whisper asks twice at most, a chunk twice, three 429s, then `failed` |
| An index with an error on its run | Tries again once its park is over, for ever | **Not again, at the first.** Transcription and extraction end in `failed`; an index has nowhere to end, and 15 minutes between tries is 96 a day. A page carries it on |
| The daily limit, its time passed | Tries | Tries: it ends by itself, at most once a day, as the spec holds over three days |
| A provider blocked, or its slot taken | Claims, finds out, parks | **Claims nothing.** A step needing it is passed over for one that does not, and with none the meeting is not chosen |
| Another model's index (`held`) | Leaves it | Leaves it |
| The public demo | 403 | Never chosen |

`busy` comes back from the same request as the meeting, so knowing costs nothing, and the slot itself still decides for whoever got there first. A tick never waits for a slot.

**Questions share the Groq slot, and are not starved by this.** A tick takes one slot at most, every 5 minutes, at no wait. So a question can find a chunk step's slot in its way for 60 s of every 300, as with any other caller, and from there has it to itself, with its 20 s wait and `Retry-After` as before. One that got there first sends the tick elsewhere. `sweep.spec.ts` holds this over 8 chunks.

**Beside an open tab,** nothing is special. The claim decides, and a tick that loses it answers `progress` or `refused` and stops, quietly. A live step of a tick blocks a delete like any other, and a meeting deleted during one gets nothing written back. Under workerd: a tab asking during a tick's Whisper call is told `wait`, a second tick finds nothing, and Whisper is asked once.

**Errors and logs.** The hook calls `controller.noRetry()` first, and nothing a tick does can throw. Cloudflare documents no retry of a failed cron, but it has this flag, and wrangler's `{"outcome":"ok","noRetry":true}` shows it set on every tick, including one that cannot reach the database. So the next try is always the next tick.
- **At most one line a tick.** Nothing for a tick with nothing to do. `[meetmind] sweep: extraction step, progress` for a step: its kind, and the step's own one word. `[meetmind] sweep failed: Error` for a failure: only the error's name, as its message can hold a provider's reply, a stored error or a transcript's words.
- **What the steps log themselves is dropped** (`server/utils/quiet-logs.ts`): they log a route's errors as they stand, a database's own words or an object's key with a meeting's id in it. An `AsyncLocalStorage` scopes this to the tick, so a request in the same isolate is not affected. What went wrong is on the run's row, and that is where to look.
- **The gate's refusal is the exception:** it comes before that scope, so it is still said, once per isolate, with no line of the tick's own after it.

**Keep-alive.** `sweep_next_meeting` writes `sweep_state.last_tick_at` on every tick, before it looks for anything, so a tick with nothing to do is a real write in Postgres. That is asserted in `driver-gate.spec.ts`, `sweep.spec.ts`, `verify-migrations.sh` and under workerd. **Whether Supabase counts it as activity is unproven.** Its docs say a free project "is considered inactive if it does not receive sufficient user database activity over the past week", and that a few requests a day is typically enough; they do not say an API call by the service role is one, and nobody has watched a week of it.

**What a page says.** "Find every sentence": the banner and the footer of the progress page, the meeting's page and the Questions card said a meeting moves only while its page is open. That is now true only of a server with no cron. On a Worker they say the server carries on, `at most one step every 5 minutes, shared with every other meeting`, and the footer adds `A one-hour recording takes about 30 steps`: this ADR's measured hour, as the Whisper call, about 9 pages and the last, 9 chunks, the summary, about 7 index batches and the step that finishes. No time is given, as it depends on what else is waiting and what a provider allows. A failed meeting, a held or stopped index and the demo promise nothing of it, and an index that may have kept stopping says so. The footer does not know about an index whose last step failed, as `/advance` carries no errors, so in that corner it says the server carries on while the next tick would leave it for a page.

**How the page knows.** `useDeploymentFacts`, read during the server's render from `event.context.cloudflare`, one of ADR-0016's signals, and handed over in the payload. A public setting would need remembering, and could be left on a Node server. A build constant would have to be threaded through Vite for a value Nitro already hands every request. This cannot be set from outside, and a page never rendered by a server says the less. **What it cannot know is whether the cron is really firing:** `wrangler.jsonc` has it and a test holds the page's words to it, but a dashboard change or a broken deploy would leave the sentence false. `sweep_state.last_tick_at` is where to look, and a page could read it, at one more request per read of `/pipeline`. It also says so under local `wrangler dev`, where nothing fires by itself, which is only ever a check.

**Node and `pnpm dev`** register the hook and nothing calls it. Both presets build. The e2e job holds that a Node server renders no pace, stores no rotation, and leaves a meeting alone; the browser job reads the same sentence off a driving page.

**How this was proven,** none of it on a real service:
- `scripts/verify-worker-sweep.mjs`, on the Worker build under `wrangler dev`, asking for each tick at `/cdn-cgi/local/scheduled`, with real SQL behind PostgREST on a throwaway Postgres, and fakes for R2, Groq and Workers AI that see every request. No settings, and one missing: nothing sent, the refusal said once. Nothing to do: one request, one write, no log. Two meetings from `uploaded` to `ready` with their indexes complete, in 14 ticks, one claim and one provider call each at most, 18 subrequests at most, and the demo untouched. Whisper failing for ever: asked twice, then `failed`, and not retried past its cooldown. The daily limit: one request, then none. No provider body or value in any log.
- `pnpm test:postgrest`, the 48 cases and the rotation through the real Supabase driver.
- `verify-migrations.sh`, in `pnpm ci:local`, the same on the SQL: the cases that matter most, what it reads, two sessions at once, who may run it, running it twice.
- `tests/unit/sweep.spec.ts`, whole drives over the local drivers, in fake time, including every bound above.

**Decisions to reverse if they turn out wrong:**
- **An index stops at its first failure,** which a transient 5xx can be. The cost is a meeting with no questions until someone opens its page, where it carries on. Allowing its second attempt needs telling that from a stop, and the run holds nothing that does; a flag on the cursor would.
- **A tick does one thing,** so no retry of anything in the same tick, and the one chance per 5 minutes is the meeting's, whichever it is. With a backlog of 20 meetings each waits 100 minutes for its next step. Raising the rate is a change to `wrangler.jsonc` and the page's words, at more of Groq's minute and more of the free 100,000 requests.
- **The 100 meetings looked at** are a constant in the SQL and on the local driver. Past them a meeting needs a tab.

**The retention purge** ([ADR-0017](0017-retention-purge.md)) takes a tick that has no step, if someone has turned it on, which nobody has.

**Not done, or unproven until Phase 13:**
- **The acceptance itself.**
- **That a real Cron Trigger fires this,** with values from `wrangler secret put` reaching `useRuntimeConfig(event)`. Cloudflare says a change can take up to 15 minutes to reach its network, and a new Worker up to 30 to show in Past Cron Events.
- **How long a tick may run.** Nitro's handler returns at once and runs the hook in `waitUntil`. Cloudflare gives a scheduled Worker 15 minutes of wall time, and `waitUntil` 30 s "after the response is sent or the client disconnects", and does not say which binds a scheduled handler that has returned. A Whisper call was measured at about 11 s for an hour of audio. If 30 s binds, a longer one is killed, its lease runs out, and it counts as an attempt: at most two calls, then `failed`, then nothing.
- **CPU.** Nobody can measure it yet, and no figure is claimed. Free is 10 ms a tick, as for any request. Each tick now holds a read of the choice, a read of the state and a step.
- **What the free plan's cron does with `exceededCpu`,** and how it reads in Past Cron Events.
- **Real providers.** Every provider here is a fake.
- **That Supabase counts a tick as activity,** as above.
- **That a deployed Worker has no route to a tick:** `/cdn-cgi/local/scheduled` is local by Cloudflare's account, and Phase 13 should ask it.
- **`event.waitUntil` around a step** is still not done for a route, and has no meaning here.
