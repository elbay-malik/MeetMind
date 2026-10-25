# ADR-0012: Pipeline orchestration under the Workers free plan

- **Status:** Accepted
- **Date:** 2026-10-25
- **Supersedes:** PLAYBOOK Phase 9 point 2 and its "No queue … single streaming request" key decision. Amends ADR-0006 §2–3 (per-chunk retry, chunk-local attestation), ADR-0007 §5–7 (index claim, pacing), ADR-0011 (what blocks a delete) and the Phase 13 note that "streaming AI calls … don't accrue CPU time".

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
| **ask** | Check `meeting_index_state` (no whole-transcript re-plan) → `embedQuery` → top-4 search → `reserve_slot` (bounded wait, §4) → one Groq call → attest against 4 windows | constant | ~7 |

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
- This is also the index-completeness marker ADR-0008's addendum deferred, so cross-meeting search reads it as well.

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
| Cron sweeper in v1 | Deferred, as an optional PR. See the open questions. | |

## Consequences

**Every invocation is O(constant) in CPU and in subrequests.**
- The largest step uses about 7 of the 50 subrequests, whatever the meeting's length or `MAX_CHUNKS`.
- If a step measures over 10 ms, a setting shrinks it (`SEGMENTS_PER_PAGE`, `INDEX_BATCH`, `CHUNK_BUDGET_TOKENS`); the design does not change.
- **The one exception** is the Whisper request body when the fixed-length stream is refused. The `FormData` fallback grows with audio size, up to 25 MB, and its CPU is unmeasured. It is the first thing PR 1 measures.

**Processing pauses when no tab is open.**
- A meeting whose tab is closed stays paused ("Paused at extraction 3/9 — open to resume") and resumes from the last persisted step when any tab opens it.
- This is said plainly in the UI. It is the price of using no scheduler.

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
- **Processing pauses while no tab has the meeting open**, and resumes from the
  last persisted step when one does. A Cron sweeper that advances one step of
  one meeting every 5 minutes is the last PR of this phase; it also serves as
  Phase 13's Supabase keep-alive.
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

