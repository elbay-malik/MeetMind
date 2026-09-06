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
past roughly half an hour therefore cannot be summarised in one request, and the
repository's own committed one-hour fixture reaches that. Chunks split on segment
boundaries, never inside one: segments are the unit the rest of the system speaks
in, they carry the index and offset every citation needs, and they do not cut
sentences in half. Requests run sequentially, because firing chunks in parallel
is the fastest way to exhaust the very allowance the chunking exists to respect.

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
  resolve, not that the summary is good.
