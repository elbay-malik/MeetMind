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
segment the quote was found in, rather than trusted from the model — every
occurrence anywhere in the transcript is considered (not a search radiating
out from the claimed index), and the one actually used is chosen by the rule
below.

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
`failed` meeting would satisfy no retry condition and stay stuck. `null`
alone does not fix that (it matches neither stage string either); the local
driver now normalises a legacy row that is actually `failed` to
`'transcription'` on every read, and to `null` otherwise.

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
immediately, so the migration backfills a value for any row already `failed`
before the column existed, rather than leaving it null and failing the CHECK
outright — see below for what that value actually is and why a single
constant is wrong. And the migration verifier's own FK-shape check now
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

The fencing token had a gap of its own: it only starts protecting a claim
once the ORIGINAL `claim()` call has already returned one. The stale-lease
reclaim inside `claim()` — the moment a new claim is actually established
over an expired one — was still a plain status-only compare-and-swap.
Reclaiming `indexing`/`transcribing` writes the same status back, so that
CAS never "uses up": two callers who both observe the same stale lease could
both successfully reclaim it and both go on to spend a full run's worth of
provider requests before either noticed. Fenced on the `updatedAt` both
callers actually observed, the same way every later write already was.

transcribe.post.ts's "lost the race" fallback had the same "stale in-memory
result" problem the summary route's did, just for segments instead of a
summary: once this worker's own fenced write has failed, a reclaimed worker
may have already replaced the transcript with a different one of its own.
Returning this worker's `result.segments` alongside the OTHER worker's
current meeting row could pair a status with a transcript that never
actually coexisted. Re-reads the transcript from storage instead, the same
way it already re-read the meeting.

`attestQuote`'s fragment matching used a raw substring check, which accepts a
quote that starts or ends inside a word — `"approved by everyone"` is a
literal substring of `"disapproved by everyone"`, the opposite of what it
claims to quote, and at 21 characters it clears the fragment floor outright.
Matching now requires token boundaries for scripts that actually separate
words with whitespace (`" ${haystack} ".includes(" ${needle} ")`), while
scripts with no whitespace between words (CJK, Thai) keep plain substring
matching — there is no reliable word boundary to require there, and a real
substring in those scripts is a legitimate sub-phrase, not a mid-word
accident. The script-detection regex (`NO_SPACE_SCRIPT`) is shared with
`plan.ts`'s token-cost estimator rather than duplicated, since both need the
same underlying "does this script use whitespace" answer.

The `failed_stage` backfill's "summarisation did not exist before this
migration" reasoning does not actually hold for THIS migration: Phase 6's
`meeting_summaries` table and `summarize.post.ts` shipped before this column
did, in an earlier PR, so a pre-existing `failed` row can already be a real
summarisation failure — blanket-assigning `transcription` would silently
reintroduce the exact ambiguity this column exists to resolve, for exactly
the rows it is backfilling. `summarize.post.ts` only ever runs once
`transcript_segments` rows exist for a meeting, so whether they exist is the
best available signal for telling the two apart after the fact — but it is
not a proof, and the migration says so in its own comment rather than
claiming one: before `failedStage` existed, every `failed` meeting was
retried through the transcription route regardless of which stage actually
failed, so a summarisation failure "retried" that way, whose retry then
itself failed before ever reaching `transcripts.replaceForMeeting`, leaves a
row that is genuinely a transcription failure but still carries the OLD
segments from before any of this happened — indistinguishable, from the
schema alone, from an ordinary summarisation failure. The two guesses are not
equally safe to get wrong, though: a misclassified `summarization` row
retries into `summarize.post.ts` and extracts from whatever transcript is
already there; a misclassified `transcription` row would instead retry into
`transcribe.post.ts` and unconditionally replace that transcript, the more
destructive mistake to default to. The backfill picks the less costly wrong
guess, not a guaranteed right one. The local JSON driver's equivalent normalisation had a related
gap: coercing a legacy row's missing field to `null` fixed the TYPE but not
the actual bug — both retry routes compare `failedStage` against an exact
stage string, and `null` matches neither, so a legacy failed row was still
stuck either way. It now defaults to `'transcription'` for a legacy row that
is actually `failed`, mirroring the migration's own default for the same
(more common, since summarisation is newer) case; local data cannot use the
transcript-existence check the migration does, since normalising a single row
has no repository to query against, so it does not distinguish the rarer
already-summarising case the way the migration now does.

Chunking's aggregate rate limit was not actually respected by "sequential":
two full-`CHUNK_BUDGET_TOKENS` chunks sent back to back can both land inside
the provider's same rolling minute and still exceed its aggregate allowance,
even though each fits its own per-request budget alone — chunking this
aggressively only ever worked by accident, whenever a chunk happened to take
long enough on its own to clear the window. Each chunk after the first now
waits out the rest of the previous chunk's minute before sending, which is
also why `CLAIM_LEASE_MS` grew from 3h to 4h — the worst case gained up to
`(MAX_CHUNKS - 1) * 60s` of pure waiting. Pacing between chunks was not
enough on its own, either: a within-chunk retry from `withRetries` is a real
request too, capable of the same collision as a new chunk, so pacing is
applied to every actual request (a fresh chunk or a retry alike), not to the
chunk loop specifically.

`occurs()`'s no-space/whitespace-delimited choice, initially made from
whichever script the whole SEGMENT happened to use, had the same mid-word
problem one level up: a segment can legitimately mix scripts (English naming
a place in Japanese), and checking the haystack would fall back to substring
matching for an entirely Latin quote just because the segment it is checked
against also contains one unrelated CJK character — reintroducing the exact
fabrication the boundary check exists to catch. The choice is made from the
quote alone now.

The no-space branch had a second, subtler bug: it compared `normalise()`'s
output directly, which turns punctuation into a single space rather than
removing it. A real citation that omits punctuation the transcript has (or
the reverse) then differs from the transcript by exactly that one space —
and a script with no reliable word boundary has no reason to preserve it.
Both the full-match and fragment checks now compare a further-compacted form
(all whitespace stripped, not just runs collapsed) whenever the quote is a
no-space script.

The script-detection regex itself only covered the common, Basic
Multilingual Plane ranges for each script (hand-transcribed code point
ranges, copied from a chart) — Han in particular extends into the
supplementary planes (U+20000 and up), which those ranges silently excluded,
collapsing a long segment written with one of those characters right back to
the ~6-token estimate this whole mechanism exists to prevent. Rewritten
against Unicode Script properties (`\p{Script=Han}`, `\p{Script=Hiragana}`,
`\p{Script=Katakana}`, `\p{Script=Thai}`) instead of hand-rolled ranges, which
also turned up a transcription bug in the ranges themselves: the intended
start of the CJK Compatibility Ideographs range (U+F900) had silently become
U+8C48 (its canonically-equivalent CJK Unified form) somewhere between typing
the character and it landing in the file, making that range nearly 15,000
code points wider than intended, coincidentally covering high surrogates —
this is exactly the class of error Script properties make impossible.

A retryable summarization failure (a transient 5xx, say) used to reset the
meeting to `summarizing` rather than `failed`. `summarizing` is also the
meeting's own pre-first-attempt state, and `claim()`'s first branch reclaims
it with no cooldown gate at all — so a repeated transient failure could
re-launch the whole multi-chunk run instantly, every time, exactly what the
cooldown exists to prevent. The retryable/non-retryable distinction predates
the cooldown-gated `failed` reclaim added earlier in this round; now that
`failed` recovers on its own after 60s regardless of why it failed, there is
no remaining reason for a retryable failure to land anywhere else. Every
failure here now lands on `failed`.

Two accuracy fixes with no behavioural change: `progress.vue`'s completion
announcement (`justFinished`) was never cleared when extraction starts, so it
could re-announce "Transcription finished" for an already-ready meeting once
`summarizing` fell back to false; and this document's own description of the
citation search ("tries the claimed segment, then its neighbours, then the
whole transcript") described an earlier version of the algorithm superseded
above (every occurrence is considered, not a search radiating from the
claimed index).

Pacing (above) was still scoped to one `summarize()` call, but
`useSummarizer` builds a fresh `Summarizer` per HTTP request — Groq's rate
limit is per ACCOUNT, not per meeting, so two concurrent extractions for
different meetings would each pace correctly against their own requests and
could still together exceed the same aggregate limit neither alone would hit.
`createGroqSummarizer` now accepts a `pacer` it will share instead of
building its own; `useSummarizer` constructs exactly one, module-level, and
passes it to every Groq summarizer it builds. This is a single-process fix:
multiple server instances (genuinely concurrent Workers, say) would need a
real distributed limiter, which is deferred with the same reasoning as the
rest of what Phase 9's orchestrator is for.

`GET /api/meetings/:id/summary`'s `ready` gate was still a single check, and
the `ready`-with-no-summary repair above gave a NEW way for the row to change
between that check and the summary read within the same request: the
repair's own claim (`ready` → `indexing`) and five-write sequence can start
while this handler's `getForMeeting` is already in flight, so a `ready` read
moments earlier could stand for a summary actually read mid-repair. The
status is checked again after the summary read; a mismatch returns `null`
rather than the read. This narrows the exposed window rather than closing it
outright (there is always some gap between a last check and a response being
sent without a real transaction) — verified by reading the code rather than
by an automated test, since reproducing the exact interleaving deterministically
would need mocking this codebase's test setup does not have.

`occurs()`'s mixed-script fix from the previous round was itself incomplete:
deciding the matching rule from the QUOTE's overall script still fails a
quote that mixes an entirely fabricated Latin phrase with a real CJK one in
the SAME string ("approved by everyone in 東京") — the quote contains a CJK
character, so the whole thing fell back to substring matching, letting the
Latin portion land mid-word again. There is no single "which script" answer
for a string that genuinely mixes scripts; the fix tokenizes instead —
whitespace-delimited words for scripts that use them, but each no-space-script
character as its own token — and checks whether the quote's token sequence
appears as a contiguous run in the segment's, which handles a pure-Latin
quote, a pure-CJK quote, and a mixed one identically, without a branch. This
also subsumes the previous round's separate whitespace-stripping fix for
no-space-script punctuation differences: two token sequences that differ only
in how many CJK characters a since-removed comma stood between are identical
once tokenized, with no separate handling needed.

Two more `normalise()`/`attestQuote` gaps in the same area: canonically
equivalent accented text ("café" as one precomposed character vs. as a base
letter plus a separate combining accent) normalised differently, since the
old filter kept letters and numbers but dropped combining marks as if they
were punctuation — now NFC-normalised first and `\p{M}` kept in the filter.
And the fragment/full-match length floor counted `.length` (UTF-16 code
units), so a single supplementary-plane character — one code point, two
UTF-16 units — could pass the 2-character full-match floor as if it were two
characters; now counted by spreading the string (code points), matching how
`plan.ts` already counts for the same reason.

The local transcript driver was missing the same `serialize()` queueing
`summaries-local.ts` already has: `summarize.post.ts` reads a meeting's
transcript before claiming it, so a concurrent `replaceForMeeting` (a retried
or re-run transcription for the same meeting) racing that read was a real,
not hypothetical, way to observe a torn write. Now queued per meeting id like
every other local driver.

`transcribe.post.ts`'s generic "no audio ready" refusal was actively wrong,
not just unhelpful, for a meeting whose `failedStage` is `summarization`: that
failure leaves the transcript — and the audio that produced it — completely
intact, so the message now says which route actually needs retrying instead
of implying transcription is the fix.

The shared pacer's own `wait()` had a race that only a genuinely CONCURRENT
caller (`Promise.all`, not two sequentially-awaited calls) exercises: it read
the previous start time, awaited a sleep, and only then wrote the new one —
so two callers who both invoked `wait()` before either had reached that write
could both read the same stale value, both sleep the same remainder, and
both fire together, defeating the exact pacing the shared instance exists
for. (The regression test for this needed the pacer PRIMED with one prior
call first: the very first-ever call never reaches the internal sleep at
all, since there is nothing to wait on yet, so it can never expose the race
on its own.) Fixed by reserving the next slot synchronously, before awaiting
anything — a second concurrent caller then always sees the first's
reservation, even when both call `wait()` in the same synchronous tick.

`summarize.post.ts` refused ANY meeting with zero transcript segments, but a
meeting that already reached `summarizing` (or later, or is retrying a
summarisation failure) with zero segments is a real, valid outcome — a
silent recording, which `progress.vue`'s own `transcribedButEmpty` already
names as such — not "not transcribed yet". `useSummarizer`'s own
`summarize()` already returns a valid empty summary for zero segments
without spending a provider call; the route just needed to stop refusing to
reach it. `canSummarize` had the identical bug one layer up: gated on
`segments.length > 0`, it hid the only button that could reach this route at
all for exactly the recordings that needed it, so a silent meeting was stuck
in `summarizing` with no reachable transition from either the API or the UI.

The `MAX_CHUNKS` limit had the same "stuck with no reachable transition"
shape as the two problems above, for a different reason: it threw its 413
BEFORE `claim()`, so a too-long transcript was never actually claimed, let
alone marked `failed` — the meeting stayed wherever it already was
(`summarizing`, or `ready` mid the no-summary repair) forever, with no
persisted error and every future call hitting the identical 413. Unlike an
empty transcript, this genuinely cannot be finished — chunk count does not
change between attempts — so the fix is the opposite of that one: claim the
meeting, persist a `failed`/`'summarization'` state with an accurate message,
THEN throw. It has to happen outside the try/catch below, and not simply be
moved inside it: the generic catch's `isError(err)` branch treats an h3
error as "already says what it means, don't rewrite it" and resets the
meeting back to `summarizing` — correct for a conflict raised mid-flight by
another caller, wrong here, where resetting to `summarizing` would look like
"try again" when trying again is guaranteed to fail identically.

`drive-upload.mjs`'s standalone citation matcher, duplicated by hand from
`reconcile.ts` since it cannot import a TypeScript server module, had fallen
out of sync with `reconcile.ts`'s own fixes earlier in this round: it still
decided token-vs-substring matching from the whole quote's script (not
tokenizing), and still normalised without NFC/combining-mark handling —
meaning this smoke check could itself accept a mixed-script mid-word
fabrication, or reject a valid citation over an accent's composition, the
exact two things `reconcile.ts` was just fixed to avoid. Re-synced to match.

The `failed_stage` migration's backfill comment was also corrected to stop
overclaiming certainty it cannot actually have (see the "Every citation is
checked against the transcript" section above) — the transcript-existence
signal is the best available guess, not a proof, and a specific historical
sequence (a summarisation failure "retried" through the pre-`failedStage`
transcription route, whose own retry then failed before replacing the
transcript) produces a row this backfill cannot correctly classify from the
schema alone. Documented as a genuine, accepted limitation rather than
silently left implied to be solved.

The `meetings_failed_stage_matches_status` CHECK constraint (above) only ever
protected Supabase: `MeetingPatch` still let a caller build `{ status: 'failed'
}` with no `failedStage`, or pair a stage with a non-`failed` status, and the
local JSON driver had no constraint of its own to catch it — it would write
the invalid row and never complain. Two of this codebase's own test fixtures
did exactly that (`{ status: 'failed' }` alone) as setup for something else
entirely, which is how the gap was found: nothing surfaced it until the
combination was checked for directly. `assertValidStatusPatch`/
`assertValidNewMeeting` (`server/utils/db/meetings.ts`) now enforce the same
pairing in application code, called by both drivers before every write, so
local and Supabase refuse the identical invalid shape with the identical
message — Supabase's CHECK stays as the last line of defense, not the only
one. The check works from the patch alone, never the row it will be merged
onto: every real caller that touches `status` already sets `failedStage` in
the same patch, so no extra read of the current row is needed on either
driver, and a patch that never touches `status` is left unchecked rather than
guessed at against a row neither driver's `update()`/`claim()` is actually
handed.

Three more findings from this round were UI-layer, not the pipeline itself.
`progress.vue`'s `transcribedButEmpty` — whether transcription ran and found
nothing, as opposed to not having run yet — excluded a `failed`+
`summarization` meeting, even though that failure is orthogonal to whether
the transcript it ran against was empty; hiding the warning there silently
dropped the still-true "the recording may be silent" explanation, leaving
only a generic extraction error. Extracted into a plain, shared predicate
(`shared/utils/meeting.ts`) instead of an inline computed, so this — the one
thing deciding whether that explanation shows at all — has a fast unit test
independent of mounting the page.

`transcribe.post.ts`'s "lost the race" fallback (see above, on both routes)
returned its in-memory result unconditionally once the final claim failed,
without the same status check `summarize.post.ts`'s analogous fallback
already had from an earlier round in this series — a reclaimer that was
itself still `transcribing`, or had itself since failed, would be reported to
the ORIGINAL caller as a completed 200. Brought to parity: only `summarizing`,
`indexing` or `ready` on the re-read row counts as done. Like the identical
fencing gap this ADR already discloses for `replaceForMeeting` itself, the
precise interleaving this branch exists for — another claimant landing between
this call's own renewal and final claim, inside a single request's lifetime —
could not be reproduced through this test harness (the e2e tier runs the
server as a separate process; the only lever available from outside it,
`backdateUpdatedAt`-style direct writes to the stale-lease path, cannot land
inside another request's few-millisecond window on demand). Verified by
reading the code against `summarize.post.ts`'s already-accepted version of
the same fix, not by a test built to force that exact race.

`index.vue`'s `centreOn` used `el.offsetTop`, which is relative to
`el.offsetParent` — the nearest ancestor with a `position` other than
`static` — not necessarily the scroll container doing the centring. The
transcript's own scroll container has no `position` of its own (just
`overflow-y-auto`), so `offsetTop` was actually relative to whatever
positioned ancestor was nearest — the page itself, with the summary and
player content above the transcript pushing everything down — computing a
wildly oversized `scrollTop` that jumped the list to its bottom instead of
centring the active line. Fixed by comparing `getBoundingClientRect()`s
instead, which is independent of the `offsetParent` chain entirely. Fixing it
surfaced a second, previously-latent bug it had been silently masking:
`resumeFollow()` calls `centreOn()` directly rather than through the
`followIndex` watcher, and setting `scrollTop` fires a native `scroll` event
same as a user's own scroll would — `onListScroll` was reading that as the
user taking over and flipping `followPlayback` straight back off, undoing the
resume within the same tick. The old, broken `offsetTop` math happened to
compute a `scrollTop` that clamped to wherever the container already was in
the one scenario this was ever exercised in, so no `scroll` event fired and
the bug stayed invisible; the corrected math actually moves the scroll
position, which is what exposed it. Fixed by having every programmatic
scroll — not just the one reached through the watcher — record where it left
the scroll position before the resulting `scroll` event can be misread.
`scripts/drive-player.mjs` gained an assertion that the active line is
actually visible inside the (deliberately shrunk) container after resuming,
which is what caught both of these against a real browser; a JSDOM/happy-dom
mount would not have, since neither computes real layout for
`getBoundingClientRect()`.

### 8. What a review of this branch found that ten rounds of automated review did not.

Copilot's review quota ran out mid-series, so the branch was reviewed again by
hand, with four independent adversarial passes and every load-bearing claim
checked against the code. Most of what it found were not new kinds of bug.
They were the same kinds this ADR already records fixing, in places the earlier
fixes had not reached.

**The citation guard was never reviewable.** From the tokenize-based rewrite
onward, `reconcile.ts` held a literal NUL byte as its token separator. Git
classifies any file containing NUL as binary, so every diff of it, including
this PR's, read "Binary files differ". Five review rounds passed over the one
file where model output becomes stored data without being able to see it. The
NUL was also fragile in a fail-open direction. A tool that strips control
characters would turn the separator into `''`, and joining tokens with an empty
string accepts "approved by everyone" as evidence drawn from "disapproved by
everyone". The separator is now a space, which behaves identically.
`tests/unit/source-hygiene.spec.ts` fails on any control character in a tracked
text file.

**Four no-space scripts were missing.** Decision 2's fix for CJK listed
Han/Hiragana/Katakana/Thai. Whisper also transcribes Khmer, Lao, Burmese and
Tibetan. One hour of Thai planned to 9 chunks, and the same volume of Khmer
planned to 1. Citation matching failed the same way for those languages, since
each whole sentence became a single token. The scripts are added. Text in any
other script now also gets a per-character pricing floor, so the next omission
makes an estimate inaccurate rather than catastrophic.

**The fragment floor meant different things in different scripts.** Twenty
characters of English is three or four words. Twenty characters of Japanese is
a sentence. A complete 19-character Japanese clause was rejected, so CJK
meetings got citations only when a model quoted a whole segment. Every
"non-Latin" test reached the full-segment exemption, and none reached the
fragment path. No-space characters now weigh 2.5 against the floor. That weight
is a judgement: equal specificity would argue for about 5. Only the fragment
floor is weighted. The full-segment floor asks whether text is a real utterance
at all, and raw code points are the right measure for that. Punctuation between
digits is also spelled out rather than flattened, so "3.5 percent" and "3-5
percent" are no longer the same quote.

**The quote was never shown.** Decision 3 rests on the quote being the
evidence, and the meeting page did not render it. The check proves that words
were said, not that they support the claim. A real "Yeah." clears the
two-character full-segment floor and can be paired with any decision. The
quote now appears under every item. That is the actual mitigation for two
findings deliberately left unfixed in the matcher:

- **A quote can splice across a sentence boundary.** Blocking this needs
  sentence segmentation, and the obvious rule breaks real citations, because a
  period between digits or in an abbreviation is not a sentence end.
- **A quote can drop a leading negation.** "I do not think we should sign"
  quoted as "think we should sign" clears every check, and no
  substring-shaped guard can see it.

**Two dead ends were reachable from the UI.** Both had the shape this ADR
already records fixing at the API level.

- **A refused upload offered a retry that could never succeed.**
  `failMeetingUpload` deletes the object, then recorded `'transcription'`, so
  the page offered to retry transcription on audio that no longer existed.
  `failedStage` gains `'upload'`. Neither retry route reclaims that stage, so
  the impossible button is gone by construction.
- **A claim whose holder died was unrecoverable.** Each route's stale-lease
  reclaim runs only inside its POST, and the progress page never sent one for
  `transcribing` or `indexing`. The result was a spinner that polled forever.
  The leases moved to `#shared/utils/meeting`, and the page offers Resume once
  a claim is older than its lease. The server still re-checks under the
  compare-and-swap.

**The repository validation checked the wrong thing.** Decision 7's pairing
check validated the patch. Postgres constrains the merged row. `{ status:
'uploaded' }` is a consistent patch and still produces a forbidden row when it
lands on a failed meeting, and `complete.post.ts` writes exactly that shape.
The local driver now validates the merged row, and `complete.post.ts` clears
the stage under a compare-and-swap.

**Tests claimed more than they proved.** For a fix with two mechanisms, the
regression test was proven against reverting both at once, so neither half was
shown to be guarded on its own. Six mutations survived the whole suite:

- `upsert` to `insert` in the Supabase summary writer. That is a live 23505 on
  any second extraction, and e2e only runs the local driver.
- Dropping the trailing token boundary.
- Dropping `\p{M}` from `normalise`.
- Deleting every Supabase validation call.
- Dropping the route-level fence argument.
- Moving `MIN_QUOTE_CHARS` anywhere in 11-24.

Three e2e assertions passed on an empty summary. The pacing tests measured
total wall time, not the gap between requests. Two `verify-migrations.sh`
labels overstated their checks. "Audio cap matches MAX_AUDIO_BYTES" used
`LIKE '%25000000%'`, which a cap ten times too large satisfies. The RLS check
passed with two of its three tables missing. Each is fixed and proven by
re-running the mutation that previously survived. CI now also runs the
migration check and both browser drivers. The drivers are the only thing that
caught the scroll-centring and follow-playback bugs, and until now nothing ran
them automatically.

Two limitations are stated rather than fixed:

- **Cooldown fences are not independently tested.** Both routes now fence
  their cooldown-gated `failed` reclaim. That the route passes the fence cannot
  be observed without the race it exists to lose. The repository's enforcement
  of a fence is tested.
- **The claim lease is not an upper bound under concurrency.** See
  `CLAIM_LEASE_MS` in `summarize.post.ts`. The shared pacer's queue is
  unbounded, so enough concurrent worst-case extractions push a still-waiting
  run past its lease. Data stays consistent, because the reclaimed run's
  fenced writes fail, but its quota is wasted. That comment's earlier
  arithmetic (2h39m) also double-counted pacing that overlaps request time.
  The real single-run bound is about 2h.

## Consequences

- A long meeting costs several sequential, PACED requests — not merely
  sequential, but spaced out against the provider's own rolling-minute window,
  so two full-budget chunks sent back to back cannot collide with the
  aggregate per-minute limit the way two merely-sequential ones could — so
  extraction takes longer than transcription and is more exposed to the
  per-minute allowance. A malformed reply is retried per chunk (`withRetries`),
  but a chunk that exhausts its retries fails the whole call; the next attempt
  restarts from the first chunk, not a resumable one. A truly resumable
  per-chunk retry belongs to Phase 9's orchestrator, which is the thing that
  would actually track progress across attempts.
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
  normal transcription would break them). The stub summarizer has a third,
  same-shaped option (`NUXT_SUMMARY_STUB_FAIL_ONCE_RETRYABLE`) for a
  transient, retryable failure, also its own isolated spec file for the same
  reason.
- The e2e/driver citation checks only verified the first 20 normalized
  characters of a quote against its segment, which would not catch a future
  regression that only checked a prefix the same way — both now check the
  complete normalized quote.
- `reconcile()`'s `normalise()` and `occurs()` are exported and reused by every
  check that needs to know whether text supports a quote.
  - The e2e citation assertions import them directly.
  - The browser driver cannot import a TypeScript server module, so it uses a
    plain-JS copy. That copy drifted from the original twice when it was a
    block pasted inside `drive-upload.mjs`. It now lives in
    `scripts/lib/citation-match.mjs`, and
    `tests/unit/driver-citation-parity.spec.ts` holds it to the real
    implementation over a case list and 2,000 randomised pairs.
  - The parity test's first draft had no digits in its fuzz alphabet, so it
    passed through a real change to the digit rule. It has digits now.
- Known limitations, recorded rather than fixed:
  - **The local fencing token has millisecond resolution.** The local
    driver's `updatedAt` often repeats on consecutive writes. That is safe
    today, because every place a second writer can appear is gated behind a
    15-minute or 4-hour staleness check. Supabase's token comes from `now()`
    at microsecond resolution.
  - **The local driver has no citation foreign key.** Supabase cascades a
    stale citation away when a transcript is replaced. The local driver, which
    every e2e test and both drivers use, leaves the citation pointing at a
    segment index that may no longer exist. Nothing re-transcribes an
    already-transcribed meeting yet.
  - **`MAX_CHUNKS` is defensive only.** 40 chunks at 5,000 estimated tokens
    (2,500 since the addendum below) is about 200k (100k) tokens, which the 25 MB audio cap cannot produce for
    whitespace-delimited text. Its dead-end fix still matters: an unlisted
    script mispriced below the floor, or a change to either limit, could
    reach it.

## Addendum, 2026-10-25: each request has to fit one minute's token allowance

Measured during the Phase 9 spike, on a synthetic but realistic one-hour
meeting (73 decisions, 73 action items), run through the real routes against
the real Groq account. The meeting **could not be summarised at all**.

- The provider's default output cap for `openai/gpt-oss-120b` is **3,072
  tokens**, and the request never set one. At the default reasoning effort the
  model spent 2,850–4,413 of them reasoning before writing any JSON. The reply
  was cut off, strict mode refused it as `json_validate_failed` with an empty
  `failed_generation`, and at temperature 0 every retry failed the same way.
- Raising the cap was not enough. A 5,000-token chunk and its reply came to
  about **9,800 tokens, more than the free tier's 8,000 per minute**. The
  provider refused the request up front with **413** "Request too large", though
  not consistently.

What changed:

| | Before | After |
| --- | --- | --- |
| `CHUNK_BUDGET_TOKENS` | 5,000 | **2,500** |
| `max_completion_tokens` (summary) | unset (3,072) | **4,500** |
| `max_completion_tokens` (answer) | unset (3,072) | **1,500** |
| `reasoning_effort` (both) | default | **low** |

At low effort a dense 2,500-token chunk measured about 1,780 reply tokens, of
which 311 were reasoning, and the result was the same across runs. The raw
reply held every decision and action item in the chunk, quoted verbatim.
`tests/unit/groq-token-budget.spec.ts` holds the sum: a full chunk, or the
largest question context, plus its whole output budget must fit
`TOKENS_PER_MINUTE`.

The cost of smaller chunks is time. A one-hour meeting is now about 9 requests
at the pacer's one per minute, about 8 minutes in total, where before it failed
outright. Q&A is unaffected apart from its pacing.

Found in the same run and fixed separately: `reconcile` dropped most of those
correctly quoted items, because Whisper splits sentences across segments and a
quote was only accepted within one segment.

