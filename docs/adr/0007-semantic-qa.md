# ADR-0007: Semantic Q&A — windowed embeddings, answers held to the same citation check

- **Status:** Accepted
- **Date:** 2026-09-14

## Context

Phase 7 lets a user ask a question about one meeting ("what did we decide about
the budget?") and get an answer whose citations seek the player to the moment
they were said.

The playbook specifies `gemini-embedding-001` at 768 dimensions via
`@ai-sdk/google`, pgvector with an HNSW index, "semantically coherent" chunks,
and citations that seek a Wavesurfer player. Four of those did not survive
checking. Two decisions from earlier phases also constrain this one:

- **Citations must be checked against the transcript.** ADR-0006 established
  that a model's citations are verified before anything reaches the user, and
  that the words being said is the most a check like that can prove.
- **Groq's limit is per account.** Every Groq request in the process goes
  through one shared pacer (ADR-0006), because the per-minute token allowance
  belongs to the account, not to a meeting.

This machine has no Gemini key and no Supabase project, so, like Phases 3–6,
every cloud driver here is proven against stubbed responses and a local driver,
and runs for real only once keys exist.

## Decision

### 1. `gemini-embedding-2`, not the playbook's `gemini-embedding-001`.

Google's embeddings documentation lists `gemini-embedding-2` (stable, April
2026) as the current model. `gemini-embedding-001` is still stable but is the
older one. The newer model matters here for three concrete reasons:

- **A larger input limit.** It accepts 8,192 input tokens against 2,048.
- **It normalizes shortened vectors itself.** Truncating to 768 dimensions with
  001 requires the caller to re-normalize, or similarity scores are silently
  wrong.
- **Tasks are text prefixes.** Documents are embedded as
  `title: none | text: …` and questions as `task: question answering | query:
  …`, instead of through a `taskType` field.

768 dimensions, one of Google's recommended sizes. Requested through
`embedContentConfig.outputDimensionality`, since the top-level field is
deprecated. The driver rejects any vector that is not exactly 768 finite
numbers, so a request that silently fell back to the 3,072-dimension default
fails on its first real call rather than storing vectors the schema cannot hold.

Plain `fetch`, not `@ai-sdk/google`, for the reasons ADR-0006 recorded for the
Groq driver: the SDK would hide the request shape without removing the need to
validate the response.

### 2. The unit of retrieval is a window of consecutive segments.

A transcript segment is a few seconds of speech. Embedded alone, "yes, let's
do that" retrieves nothing useful, because what it agrees to is in the segment
before. The playbook's "semantically coherent chunks" would need a model call
to find topic boundaries, which spends quota for a gain nobody has measured.

Windows are built greedily from segments in order:

- **Size.** A window ends once it spans about 45 seconds or reaches its token
  budget, whichever comes first.
- **Overlap.** Each window starts with the last segment of the previous one, so
  an exchange that crosses a boundary appears whole in at least one window.
- **Long segments.** A single segment over the budget becomes its own window
  rather than being split, since segments are the unit citations speak in.

Each window stores its segment range, its time span, its text, and a hash of
that text. Windows are deterministic: the same transcript always produces the
same windows with the same hashes.

### 3. Answers carry quotes, and quotes go through `attestQuote`.

A question is embedded, the nearest windows are retrieved, and their segments go
to the model, which must answer with citations of the form `{ quote,
segmentIdx }`, exactly as extraction does.

Every citation is then checked with ADR-0006's `attestQuote`, against **only
the segments that were retrieved**, not the whole transcript. A quote that
occurs elsewhere in the meeting but was not in front of the model cannot have
been what it read.

- **Unsupported citations are dropped.** A citation that does not attest is
  removed before the answer is returned.
- **No surviving citation, no answer.** If none survive, the response says the
  meeting does not contain an answer rather than presenting an uncited claim.
- **The quote is shown.** Every citation renders its quote, for the reason
  ADR-0006 decision 8 gives: the check proves words were said, not that they
  support the claim.

### 4. Per-meeting search is exact. HNSW waits for Phase 8.

Windows live in a pgvector table and are searched through a SQL function. That
function takes the meeting, the question's vector, the model name, and a limit.

No HNSW index yet, despite the playbook. A single meeting has on the order of a
hundred windows, so an exact scan filtered by meeting is cheap and returns
exactly the nearest windows. An HNSW index combined with a selective filter can
return fewer rows than asked for unless iterative scans are configured. That
cost only pays off when searching across every meeting, which is Phase 8. The
index is added there, with the filtering question answered then.

The local driver stores windows as JSON and computes cosine similarity in
memory. The stub embedder hashes script-aware tokens (the same tokenizer
reconciliation uses) into a fixed-size vector. Texts sharing words land close
together, so retrieval behaves meaningfully in every credential-free test tier
instead of returning noise.

### 5. The index is resumable, and tied to its model and text.

Every stored window records the model, the dimensions, and its text hash.
Indexing plans the windows from the current transcript and does three things:

1. **Skips** every window already stored with the same hash and model.
2. **Embeds** the rest in batches of at most 100 texts. The API documents no
   limit, so 100 is a conservative cap.
3. **Deletes** stored windows the plan no longer contains.

That shape is forced by the quota, which Google no longer publishes. A
third-party measurement on 2 September 2026, read from the quota fields of the
API's own 429 responses, gave `gemini-embedding-2` 100 requests a minute and
1,000 a day on the free tier. Whether one batch call counts as one request or
one per text is not documented and cannot be tested without a key. Indexing
that stops partway therefore has to resume without re-spending what it already
used.

The hash also handles a replaced transcript: its windows no longer match, so
they are re-embedded. Search results are checked the same way at question time.
The plan is recomputed from the current transcript, and any retrieved window
whose hash no longer matches marks the index stale. A stale index asks for
re-indexing rather than answering from text that is no longer there.

### 6. The index is not a meeting status.

`indexing` already exists in the meeting status machine, but it is Phase 6
extraction's in-flight claim marker, not anything that indexes. Adding real
indexing to the same machine would mean either overloading that name or
migrating every row to rename it, in the middle of a pipeline that is working.

Index state is instead derived from the stored windows: none, stale (hashes or
model no longer match the transcript), or ready. It is driven by its own route,
offered on the progress page as a separate step after transcription and
independent of the summary. Phase 9's orchestration redesign is where the
misleading status name and the manual steps are resolved together.

### 7. Questions share the Groq pacer.

Answering a question is a Groq request against the same per-account token
allowance extraction spends, so it waits in the same shared pacer (ADR-0006).
During an extraction a question can therefore wait up to a minute. The UI says
the question is queued, rather than a separate pacer letting a question collide
with an extraction chunk and fail with a 429.

Embedding a question is a Gemini request, a different provider with its own
quota, so it is not paced.

## Consequences

- **Asking needs an index first.** The progress page offers indexing after
  transcription, and the question box explains when the index is missing or
  stale instead of failing.
- **Every question costs quota.** Each one spends one Gemini request and one
  paced Groq request, and nothing caches answers.
- **Answers can be empty.** An answer whose citations all fail the check is
  withheld. That is the intended trade: an honest "not found" over a fluent
  uncited answer.
- **The migration check needs pgvector.** `verify-migrations.sh` moves from
  `postgres:17-alpine` to a pgvector image, since the stock image has no
  `vector` type.
- **A dimension change is a migration.** The table's vector column has a fixed
  768 dimensions; a model with a different size needs a migration, not just a
  config change.

## Alternatives considered

- **`gemini-embedding-001`**: smaller input limit, and manual re-normalization
  after truncation, a correctness burden with no offsetting benefit.
- **Embedding each segment on its own**: too little context per vector, and
  around six times as many texts per meeting against a daily quota.
- **Topic-based ("semantically coherent") chunking**: needs an extra model call
  per meeting to find boundaries, for a retrieval gain nobody has measured.
- **An HNSW index now**: no benefit at the size of one meeting, and a filtered
  HNSW scan can under-return. Deferred to Phase 8, where it is needed.
- **Indexing on the first question**: no extra step, but a slow first answer,
  and quota spent at the moment a user is waiting.
- **A separate pacer for questions**: faster answers during an extraction, at
  the cost of 429s when both land in the same rolling minute.
