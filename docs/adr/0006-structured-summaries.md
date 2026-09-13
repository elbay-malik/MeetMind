# ADR-0006: Structured summaries — chunked extraction, citations checked against the transcript

- **Status:** Accepted
- **Date:** 2026-09-06

## Context

Phase 4 leaves a timestamped transcript; Phase 5 made it playable. Phase 6 turns
it into a summary with decisions and action items, each pointing back at the
moment it was said.

Three of the playbook's instructions for this phase did not survive checking.

## Decision

### 1. A model that can actually do structured output.

The playbook names `llama-3.3-70b-versatile`. It is still a current model, but it
does not support structured outputs at all — only the `gpt-oss` models do on this
provider. Since constrained decoding against a schema is the entire mechanism
this phase depends on, the model choice follows the capability.

### 2. Chunked extraction, which this time is genuinely required.

Phases 4 and 5 each found a playbook step aimed at a condition that could not
occur. This is not a third: the transcript really does have to be split. But the
playbook's stated reason — the daily token allowance — is not the binding one.
The per-minute allowance is.

A one-hour transcript is roughly 11,500 tokens of text, and with instructions and
a reply it needs about 13,500 against an 8,000-per-minute allowance. Anything
past roughly half an hour therefore cannot be summarised in one request, and a
local one-hour recording reaches that (see ADR-0002; the fixture itself is
gitignored, not committed to the repository). Chunks split on segment
boundaries, never inside one: segments are the unit the rest of the system speaks
in, they carry the index and offset every citation needs, and they do not cut
sentences in half. Requests run sequentially, because firing chunks in parallel
is the fastest way to exhaust the very allowance the chunking exists to respect.

Estimating cost by word count assumes the transcript uses whitespace between
words at all — Japanese, Chinese and Thai do not, so the whole utterance
counted as a single "word" and was costed at a handful of tokens regardless of
its real length, silently defeating the budget for exactly the languages
transcription already supports. A ratio-based check on the whitespace split
cannot tell this apart from ordinary English (a script with no spaces still
produces exactly one "word", so its chars-per-word ratio just tracks text
length). `estimateTokens` instead tests the text directly for Hiragana,
Katakana, CJK ideographs or Thai characters and costs those per character,
which is close to how those languages actually tokenize.

Chunk count is also capped outright (40, checked before any request is sent):
nothing else bounds how many sequential requests one call can trigger, and a
transcript needing more would tie up a request handler for minutes and spend the
provider's whole quota on a single caller.

### 3. Every citation is checked against the transcript.

A model asked to quote its evidence will sometimes produce a fluent quote that
nobody said. So the model is asked for the quote *first* and the claim second —
under constrained decoding keys are emitted in schema order, which makes "find
the evidence before stating the claim" a property of the schema rather than a
request in prose — and then every quote is looked for in the real transcript.

Anything that is not found is dropped. Timestamps are resolved here, from the
segment the quote was found in, rather than trusted from the model. The search
tries the claimed segment, then its neighbours, then the whole transcript: a
model that gets the words right and the index slightly wrong is far more common
than one that invents both.

This is the single place model output becomes stored data, so it is the only
place a hallucinated citation can be stopped.

Among everywhere a quote occurs, the nearest occurrence to the model's claimed
index is preferred over the first one in transcript order — ordinary meetings
repeat short phrases ("sounds good", "let's move on"), and picking the first
match anywhere would silently attribute a citation to the wrong moment rather
than the one nearest where the model said it was. A short quote is trusted only
when it is the cited segment's *entire* text; a fragment has to clear a much
higher length floor, since a short generic fragment ("the vendor", "next week")
occurs constantly and proves nothing about the specific claim attached to it.

**This proves the quoted words were said. It does not prove the model's claim
about them is accurate.** A short but real quote can still be paired with a
decision or action item that misrepresents it — closing that gap needs a
semantic check against a judge model, which would spend the same scarce quota
this design protects, and is deferred with the same reasoning as judging output
quality (below).

### 4. Absent is not unknown.

An assignee and a due date are nullable, never optional. A model forced to name
someone will invent a name, so "nobody was named" has to be expressible — and it
means something different from the field being missing, which is a protocol
violation worth retrying rather than coercing. The database enforces the same
distinction, and the interface says "nobody named" rather than leaving a blank.

Due dates are stored as spoken. Resolving "next Friday" needs a meeting date and
a timezone, and the meetings table has neither: `created_at` is upload time, which
is not when the meeting happened.

### 5. Plain fetch, and half of ADR-0004's reasoning has expired.

That record gave two reasons for skipping the SDK: it typed the response so
loosely that everything had to be validated anyway, and avoiding the dependency
kept the bundle small for Workers. **The second reason is now dead** — Cloudflare
removed the compressed-size limit, and the limit is 64 MiB uncompressed on every
plan, against which the SDK is about one percent. Recycling it would be dishonest.

What still holds: the SDK would hide the schema work rather than remove it, since
the provider's strict mode is narrower than JSON Schema and needs a normaliser
either way; and its retry covers transport failures, not a reply that misses the
schema — which is precisely what the acceptance criterion asks to retry.

### 6. Streaming partial output is impossible, not deferred.

The playbook asks for it. The provider does not support streaming alongside
structured outputs, so it cannot be built as specified.

### 7. `failed` needed to say which stage failed, once two stages could fail.

Transcription could already fail non-retryably before this phase; extraction
adds a second way to land on `failed` with the transcript completely intact.
Nothing recorded which — the retry route and the progress screen both treated
any `failed` meeting as a transcription failure, so retrying a summarisation
failure re-ran transcription and overwrote a perfectly good transcript. A
`failedStage` column disambiguates, and each route's claim only reclaims a
`failed` meeting it caused.

The reclaim itself, and the writes that follow a claim, are compare-and-swap
against the status the claim itself set (`indexing`), not plain updates. A
worker whose lease has expired can be superseded, and its own eventual
success-or-failure write must not regress whatever the meeting has since become
— a plain write would; a write conditioned on the row still showing the status
this call claimed will not. The same reasoning gives the `failed` reclaim itself
a short cooldown: extraction is several sequential requests, not one, so an
instant retry after a failure immediately re-hammers the provider with the
whole run again. `transcribe.post.ts` carries both of these too, for the same
reason: its final writes were still plain, unconditional updates, and its
`failed` reclaim had no cooldown at all.

Status alone is not quite enough of a compare-and-swap, once a status can be
reclaimed into itself: a stale-lease reclaim of `indexing` writes `indexing`
again, changing `updatedAt` without changing `status`. A caller whose own
claim predates that reclaim still matches a `from`-only condition, so its own
later write can land after it has already been superseded. `claim()` takes an
optional `updatedAt` fence for this — the caller passes back the value it
observed when it first claimed the row, and the write only lands if that value
still holds. The claim lease itself is also now sized to the actual worst case
(`MAX_CHUNKS` sequential requests, each retried once, each bounded by the
provider's own request timeout — about two hours) rather than a round number
that a legitimately slow run could exceed.

A local JSON row written before `failedStage` existed has no such property,
which `unstorage` hands back as `undefined`. Both retry routes compare it
against a specific stage string, which `undefined` matches neither — an old
`failed` meeting would satisfy no retry condition and stay stuck. The local
driver now normalises a missing field to `null` on every read.

A 429 from Groq is no longer retried within a chunk. `withRetries` has no
backoff, so retrying a rate limit immediately just hits it again; the actual
backoff is the cooldown above, on the caller's next manual retry.

`GET /api/meetings/:id/summary` is gated on `status === 'ready'` rather than
returning whatever the summary tables hold. `replaceForMeeting` is five
sequential, non-transactional writes — PostgREST has no cross-call transaction
— so an ordinary transient failure on any one of them leaves a readable but
wrong record (the old summary paired with newly emptied items, for instance).
The meeting only reaches `ready` once every step has completed, so trusting
that status is what keeps a reader from ever observing a mid-write state; it is
the smaller fix the finding that raised this allowed for, short of wrapping the
five calls in a real transaction.

The fencing token alone still left a gap: it protects the meeting row's own
status column, but `replaceForMeeting`/`transcripts.replaceForMeeting` have no
compare-and-swap of their own, so a superseded worker that finishes anyway
could still overwrite the reclaimer's data before its own status write
correctly failed — the reader would then see a meeting whose status reflects
one worker's outcome and whose stored data reflects the other's. Both routes
now renew the fence with a second claim (same status back to itself) *right
before* that write, and abort with a 409 if it fails. `summarize()`/
`transcribe()` — up to MAX_CHUNKS sequential provider calls, or one
transcription call — is the slow part; re-checking ownership immediately
before writing shrinks the exposed window from that entire call down to the
gap between the renewal and the write itself. That gap is not literally zero
— closing it fully needs the same real transaction the five-write sequence
above is already missing, for the same PostgREST reason — but it is the
closest either route gets without one, and turns "an old worker resumes
minutes later" into "two requests would have to land within the same
round-trip," which is a different, much smaller kind of unlikely.

Losing that race honestly matters too: both routes' "lost the race" fallback
used to return a status and summary/segments this call could not actually
prove were authoritative — including, in one path, a `ready` status that had
never been persisted at all when no stored row could be found. Both now
either re-read the row that is actually authoritative or refuse with a
conflict, never fabricate one.

The `failed_stage` column's check constraint also asserts, not just names in a
comment, that the column is non-null exactly when `status = 'failed'` — every
write in this codebase already keeps that invariant, so enforcing it catches a
future write that does not. Adding a CHECK validates every existing row
immediately, so the migration backfills `failed_stage = 'transcription'` for
any row already `failed` before the column existed — summarisation, and so a
summarisation failure, did not exist before this migration, so that backfill
value is not a guess. And the migration verifier's own FK-shape check now
compares actual column names, not just column count and target table: a
composite FK can be the right shape (two columns, right target table, right
cascade) while still being wired from the wrong two source columns.

Separately: the early-return that lets a repeat call skip straight to a
stored summary used to trigger on `indexing` as well as `ready`. `indexing` is
the in-flight marker `claim()` itself sets — not "done" — and a re-transcribed
meeting can be genuinely `indexing` again while `meeting_summaries` still
holds the *previous* run's row (re-transcription cascades a stale citation
away but does not delete the summary itself). A concurrent caller hitting
that window would have been handed the stale summary instead of a 409. Now
only `ready` counts.

`ready` with no stored summary row is a different, rarer shape: not a race
between two live callers, but a broken invariant (the row deleted some other
way; nothing in this app does that today). The two routes used to treat it as
a dead end — `claim()` never accepted `ready` as a state worth reclaiming, so
retrying just produced a confusing "it has no transcript ready to summarise"
conflict, forever. Nothing else can ever put a meeting *back* in `ready`
except the write immediately after a real summary is stored, so reclaiming a
`ready`-with-no-summary row cannot collide with another worker's legitimate
progress — it is a repair, not a race to arbitrate. Both routes' generic
conflict message had the same "dead end" shape for a cooldown refusal: it read
as "there is nothing to summarise/transcribe" when the real, temporary reason
was the cooldown, exactly while the progress page's retry button is showing.
Both now say which it is, with the remaining wait.

A retryable Groq 429 during transcription used to reset the meeting straight
to `uploaded` — the friendly, no-cooldown reset a transient blip deserves.
`uploaded` has no cooldown gate at all, so a client retrying immediately could
hammer the very quota that just refused it, with no backoff whatsoever (worse
than the flat cooldown summarisation's own quota errors already had). A 429
now routes through `failed` instead, purely to get the cooldown; a transient
storage/network blip still gets the friendlier `uploaded` reset. Neither
cooldown is an exact wait — Groq's `Retry-After` can ask for longer than the
fixed ceiling both routes use, and neither currently carries that specific
number across requests to honour it exactly. Bumped to 60s (was 30s), which
comfortably covers a per-minute throttle window resetting; closing the gap
completely needs a persisted per-failure deadline, which is more machinery
than this fixed cooldown for a bounded, worst-case-one-extra-retry problem.

## Consequences

- A long meeting costs several sequential requests, so extraction takes longer
  than transcription and is more exposed to the per-minute allowance. A failure
  part-way is retried per chunk, not from the start.
- Chunk boundaries make the same decision likely to be reported twice; items
  restated at the same moment are collapsed.
- Items are stored with a composite foreign key onto the transcript segment they
  cite, so the database refuses a citation that points at nothing, and
  re-transcribing a meeting cannot leave items citing segments that are gone.
- The stub quotes the transcript rather than inventing content, so it exercises
  the same reconciliation path and the citation-to-player link end to end. It
  says in its own text that it is a placeholder, and the interface labels it.
- Extraction is invoked by a button. Nothing in this phase orchestrates it,
  because that is Phase 9.
- `decisionSchema` and `actionItemSchema` (shared/schemas/summary.ts) are
  enforced by `reconcile()` as a defensive assertion on its own output — not
  requested from the model, but a future bug in that function now fails loudly
  instead of a malformed row reaching storage.

## Alternatives considered

- **The Vercel AI SDK** — reasons above. Worth revisiting if a second provider
  arrives, which is what a provider abstraction is actually for.
- **Resolving due dates into calendar dates** — needs an anchor we do not have.
  Storing the words keeps the information without inventing precision.
- **A confidence score per item** — self-reported model confidence is
  uncalibrated and an interface would over-trust it. The quote is the evidence,
  and whether it attests is something we compute rather than something the model
  asserts.
- **Judging output quality with another model** — spends the same scarce
  allowance this design exists to protect, and is not reproducible in CI.

## Follow-ups

- Nothing here has run against a real model. `pnpm test:services` covers the
  transcription endpoint; the chat endpoint should join it once a key exists.
- Extraction quality is unmeasured. The automated checks confirm that citations
  resolve, not that the summary is good — and, per decision 3, not that a
  passing citation actually supports the claim attached to it.
- The credential-free test tiers only ever see the stub's own quotes, which are
  always real. A canary option on the stub (`NUXT_SUMMARY_STUB_CANARY`, used
  only by `tests/e2e/summary-api.spec.ts`) injects one deliberately unsupported
  citation so the drop path is exercised over the real route; without it, a
  disabled reconciliation check would go unnoticed by every credential-free test.
  The stub transcriber has the equivalent for quota exhaustion
  (`NUXT_TRANSCRIBE_STUB_QUOTA_FAIL`, its own isolated spec file since it fails
  exactly once for the whole process — sharing a file with tests that expect a
  normal transcription would break them).
- `reconcile()`'s `normalise()` is exported and reused everywhere a check needs
  to know "does this text support that quote" — the e2e citation assertions and
  `drive-upload.mjs`'s standalone one (duplicated there by hand, since it is a
  plain Node script, not a place a TypeScript server module can be imported
  into). A raw case-insensitive substring check accepts less than reconciliation
  does, so it can reject a citation that was correctly stored.
