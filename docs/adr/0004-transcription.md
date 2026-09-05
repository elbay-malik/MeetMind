# ADR-0004: Transcription — one request per meeting, no chunking, with a stub provider for credential-free development

- **Status:** Accepted
- **Date:** 2026-09-05

## Context

[ADR-0003](0003-upload-and-storage.md) leaves compressed audio in storage and a
meeting row at `uploaded`. Phase 4 turns that audio into timestamped segments.

The playbook specifies chunking into ~10-minute segments with overlaps and
boundary de-duplication, and calls the timestamp offset module "the top
correctness risk". That instruction was written before Phase 3 existed, and it
rests on a premise Phase 3 removed. Re-checking the premise changed the design.

## Decision

### 1. One request per meeting. No chunking.

Chunking is not built, for three independent reasons:

- **There is no duration limit to work around.** Groq documents a maximum file
  size, a minimum file length and a minimum billed length, and no maximum length
  of any kind. Its own docs frame chunking purely as a size workaround: "For
  audio files that exceed our size limits".
- **The size limit cannot be reached.** The upload cap is enforced three times
  before a byte is stored — the zod schema at registration, a Postgres CHECK, and
  `inspectStoredAudio` at completion, which deletes the object and fails the row.
  Every object that can exist is already a legal single request. The playbook's
  condition, "for audio over 25MB", is unreachable.
- **Chunking would not lift the limit that actually binds.** The real ceiling is
  audio-seconds per hour: 7,200 on the free tier, or two hours of audio per clock
  hour. That budget is consumed by audio submitted, not by request count. Nineteen
  ten-minute chunks of a three-hour meeting cost exactly what one three-hour
  request costs. Spreading them across clock hours would help, but that needs a
  scheduler, which is Phase 9's job.

The offset arithmetic still exists, tested, in `normalizeSegments` and
`concatTranscripts`. It is the part that is easy to get wrong and cheap to pin
down, so it is written and covered rather than invented under pressure later.

### 2. Times are stored as integer milliseconds.

Whisper returns float seconds. Milliseconds compare exactly in tests, seek
exactly in the player, and do not drift when offset. Seconds do none of those.
The conversion happens in exactly one place so it cannot be applied twice.

### 3. A stub transcriber stands in when no API key is set.

Same principle as the local storage and database drivers: development, CI and
the browser driver exercise the whole pipeline with no credentials. The stub
derives deterministic segments from the audio's length and says plainly in its
own text that it is not a real transcript.

### 4. Plain `fetch`, not the Groq SDK.

The call is roughly twenty lines and the SDK earns nothing here: its
`Transcription` type is `{ text: string }`, so every field we actually need is
untyped and must be validated anyway. Avoiding the dependency also keeps the
bundle clean for Cloudflare Workers. The response is parsed leniently, because
Groq documents its per-segment fields verbatim but never publishes a full
`verbose_json` envelope — so unknown keys are tolerated, while a missing
`segments` array fails loudly rather than silently storing an empty transcript.

### 5. The server now reads audio bytes.

ADR-0003 said "the server never proxies audio bytes in production; it only HEADs
and DELETEs objects". That is no longer true, and the honest thing is to say so
rather than quietly widen it. `AudioStore.get` buffers the object and posts it to
the provider. This does not touch the privacy thesis — the raw video still never
leaves the browser, and the compressed audio was always destined for
transcription — but the architectural claim was narrower than the privacy one and
is now retired. The read is bounded by construction at 25 MB.

### 6. Transcription claims the meeting atomically before doing any work.

The claim is a conditional update — move to `transcribing` only if the row is
still `uploaded` — so the database, not the application, decides which of several
concurrent callers proceeds. A read-then-write would let every caller through:
each reads `uploaded`, each writes `transcribing`, and each then spends the
provider's quota on the same audio. The local driver serializes per meeting to
get the same guarantee across its read-modify-write.

The route always releases the claim. A retryable failure returns the meeting to `uploaded` so the
user can try again; anything else lands on `failed`. Without the release, a
single provider outage would strand meetings in a state with no way out.

On success the meeting moves to `summarizing`, which is what the progress screen
already treats as "transcribed", rather than inventing a status that would need a
new database constraint for no behavioural gain.

## Consequences

- **There is a band of recordings that upload fine and cannot be transcribed on
  the free tier.** The byte cap admits about 2.9 hours; the hourly audio budget
  allows 2.0. A recording between those figures is accepted and then rejected by
  the provider. The route surfaces that as a quota message rather than a raw 429,
  and marks it retryable, but the gap is real and only a paid tier or Phase 9
  scheduling closes it.
- Re-running transcription is a replacement, not a duplication: the composite
  primary key `(meeting_id, idx)` makes it idempotent. PostgREST has no
  cross-call transactions, so replacing a transcript is a delete followed by an
  insert, with a visible gap. That gap sits strictly inside the window where the
  meeting is claimed as `transcribing`.
- Transcription is invoked by a button. Nothing in this phase orchestrates it,
  because that is Phase 9, and a visible trigger is more honest than a background
  job that does not exist yet.
- Segment rows carry no embedding column. Phase 7 adds vectors, and whether they
  live here or in their own table is that phase's decision to make with its own
  access patterns in view.

## Alternatives considered

- **Chunk anyway, for safety** — machinery no accepted file can trigger, aimed at
  a limit it does not lift. Rejected; the arithmetic that would be hard to retrofit
  is kept and tested regardless.
- **The `url` parameter instead of uploading bytes** — Groq can fetch the audio
  itself from a presigned URL, which would keep the server out of the data path
  and avoid the CPU cost of building a 25 MB request body on Workers. Attractive,
  and probably right later, but it could not be verified from here: whether Groq
  accepts an R2 presigned GET, with its long query string and expiry, is
  undocumented. Building the verified path and recording the unverified one beats
  shipping a guess.
- **Gemini as a fallback provider** — the playbook asks for it. Deferred: Google
  no longer publishes free-tier limits for any model, a dedicated transcription
  model now exists that makes the playbook's prompt-based approach obsolete, and a
  second unverifiable provider adds more surface than confidence. The `Transcriber`
  interface is the seam it would slot into.
- **Storing float seconds, as the provider returns them** — rejected; see decision 2.

## Follow-ups

- Verify against a real Groq key: the response envelope, that Ogg/Opus is accepted,
  and whether an at-cap file is refused or served. `pnpm test:services` covers the
  first two by sending real Opus and asserting the production parser handles what
  comes back; the at-cap question still needs a full-size file.
- Measure whether building a 25 MB multipart body fits the Workers free-plan CPU
  budget; if not, the `url` path stops being an optimisation and becomes required.
- Neither the R2 nor the Supabase driver has still ever run against a real service
  ([ADR-0003](0003-upload-and-storage.md)), and the transcript driver now joins them.
