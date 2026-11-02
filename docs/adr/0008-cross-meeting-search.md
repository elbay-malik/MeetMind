# ADR-0008: Cross-meeting search — passages, not a synthesized answer

- **Status:** Superseded by [ADR-0013](0013-private-meeting-links.md). Its SQL function stayed unused until [ADR-0014](0014-workers-ai-embeddings.md)'s migration dropped it
- **Date:** 2026-09-21

## Context

Phase 8 lets a user search across every meeting they have indexed, not just
one — the archive page's own placeholder has said "lands in a later phase"
since Phase 7 shipped it.

The playbook's Phase 8 asks for "cross-meeting semantic search (same
embedding query path, without a meeting_id filter... use pgvector 0.8+
iterative scans when filtering by metadata)" and a preloaded demo meeting.
ADR-0007 decision 4 deferred exactly one piece of this here explicitly: the
HNSW-index question it postponed for a single meeting's ~100 windows, "which
only pays off when searching across every meeting."

Three earlier design choices constrain this one:

- **Indexing is a manual, per-meeting step** (ADR-0007 decision 6). A
  `ready`-status meeting can have zero indexed windows if nobody asked to
  index it. Cross-meeting search only ever sees what has actually been
  indexed.
- **A window's `idx` and segment range are only unique within a meeting**
  (the storage primary key is `(meeting_id, idx)`). Pooling matches from
  several meetings without tagging each one is a correctness bug waiting to
  surface, not a detail to add later.
- **Every route today is unauthenticated**, "matching the rest of the API
  until an auth phase" (ADR-0005) — a phase that does not actually exist
  anywhere in the playbook's Phase 0–14 list.

This machine still has no Gemini key and no Supabase project, so, like every
phase since Phase 3, the cloud driver here is proven against a local driver
and stubbed responses, and runs for real only once keys exist.

## Decision

### 1. Search results, not a synthesized cross-meeting answer.

A question box already exists per meeting (ADR-0007); this adds a second,
different thing — a search box that returns matching passages across
meetings, each linking to the moment it was said, the same acceptance bar the
playbook itself states ("returns results with correct deep-links"). It does
not ask an LLM to read several meetings' retrieved passages and write one
answer citing across them.

That would need: a `meetingId` on every citation (not just a match); the
per-meeting staleness re-check `askMeeting` already does, repeated for every
meeting a citation might come from; and a prompt that tells the model which
segment belongs to which meeting, none of which the current single-meeting
design does today. None of it is needed to meet Phase 8's actual bar, and
every extra piece is a new place to get an anti-hallucination guarantee
wrong. Search first; a synthesized cross-meeting answer, if ever wanted, is a
clean follow-on once this shape has been used for a while.

### 2. Still no HNSW index.

An unfiltered whole-table scan never hits the failure mode HNSW's
`iterative_scan` setting exists for — that only bites a scan with a `WHERE`
filter selective enough to under-return past an approximate index, and a scan
across every meeting has no filter at all. Third-party benchmarks (no
official pgvector/Supabase number exists) put sequential scan as trivially
cheap through the tens of thousands of rows and only start slowing
noticeably past roughly fifty thousand; this app's realistic ceiling —
dozens to low hundreds of meetings, on the order of a hundred windows each —
lands one to two orders of magnitude below that. Storage tells the same
story: an HNSW index would roughly double the table's footprint, and even
that leaves hundreds of meetings' worth of room under Supabase's 500MB cap.
ADR-0007 decision 4's reasoning was never really about being scoped to one
meeting; it generalizes cleanly to the whole table at this app's scale.

### 3. A new function and a new repository method, not widened existing ones.

`match_transcript_windows` and `TranscriptIndexRepository.search` keep their
exact "within one meeting" contract, byte for byte, as every existing caller
and test already relies on it. A new SQL function,
`match_transcript_windows_across_meetings`, and a new interface method,
`searchAcrossMeetings`, sit beside them instead. (Passing a null meeting id
into the existing function would not have worked anyway: `w.meeting_id = null`
is never true in SQL, so it would have silently returned zero rows rather
than "every meeting.")

### 4. Capped per meeting, ranked by each meeting's own best match — not a flat top-K.

A flat top-K across every window in every meeting lets one long, repetitive
meeting crowd every other meeting out of the results — a bad outcome for a
tool whose value is "find the meeting where X came up." Results are capped
at `MAX_MATCHES_PER_MEETING` (5) windows per meeting, across at most
`MAX_MEETINGS` (20) meetings, chosen by each meeting's own single nearest
window.

The SQL implementation is a two-stage query — rank meetings by their best
match, then a `LATERAL` join to pull each chosen meeting's own top windows —
deliberately not a `ROW_NUMBER() OVER (PARTITION BY meeting_id)` window
function. The window-function approach has to materialise and rank the
*entire* filtered set before it can discard anything, so it cannot stop early
per meeting even with an index present. The `LATERAL` join is, concretely,
one call of exactly the same exact-scan-over-one-meeting query
`match_transcript_windows` already runs, once per candidate meeting — cheap
for the reasoning decision 2 already gives. The local driver mirrors this in
plain code: rank every meeting's own windows first, then rank meetings by
their own best match.

### 5. A result seeks to its window's own start, not a model-picked line.

Per-meeting Q&A can point at one specific sentence because an answering model
read the retrieved lines and named one (checked against the transcript by
`attestQuote`). Search has no model in the loop — a plain vector match names
a whole ~45-second window, not a sentence within it — so the honest seek
target is where that window starts, not a guess at which line inside it
mattered. Showing the window's full text as the result's quote lets a reader
judge relevance themselves rather than trusting a specific line this design
has no way to pick out.

### 6. A minimum similarity floor — 0, not a tuned relevance threshold.

Retrieval ranks whatever it is given: `searchAcrossMeetings` always returns
its top-K, regardless of whether the nearest thing is actually close. Caught
by this phase's own e2e test, not designed in up front — a query sharing no
real topic with anything indexed still came back with a "result," because
nothing had ever said how weak a match was too weak to show. Per-meeting Q&A
does not have this problem: an answering model reads the retrieved lines and
`askMeeting` withholds an answer with no surviving citation (ADR-0007
decision 3). Search has no model in the loop to make that call, so a plain
floor on the match's own cosine similarity is the equivalent guard available
here — filtered in `searchMeetings`, after retrieval, the same separation
`askMeeting` keeps between "what got retrieved" and "is this actually
usable."

The floor is exactly 0: anything orthogonal or negatively correlated to the
query is excluded, and nothing higher. A real "how relevant is relevant
enough" threshold would need labelled data to tune against, which does not
exist yet for either embedder; 0 is defensible without any, since it asks
only "does this share ANY direction with the query," a much weaker and safer
claim than "is this a good result."

### 7. Ships without new rate limiting; documented as an accepted, temporary gap.

Every existing per-meeting endpoint already requires the caller to know a
specific meeting's UUID before it will spend Gemini quota — mild protection
against random abuse, on an otherwise fully open API (ADR-0005). Dropping the
`meeting_id` filter removes that: a caller with no prior knowledge of any
meeting can now spend quota with nothing but a guessable route. Phase 10
("Rate Limiting & Demo Protection") is where every route's exposure gets
addressed at once; carving out a one-off limiter for this single endpoint
ahead of that work would duplicate what Phase 10 is going to build properly,
for a feature that is not yet live anywhere reachable by the public. See
Consequences.

### 8. No preloaded demo meeting yet.

The playbook's Phase 8 also asks for one, so reviewers never need to upload.
Phase 10 already covers "the demo path bypasses upload entirely" — seeding a
demo meeting belongs there, next to the rest of demo protection, rather than
split across two phases.

## Consequences

- **Cross-meeting search is genuinely open, on an app with no auth.** Anyone
  who can reach `GET /api/meetings/search` can spend embedding quota against
  every indexed meeting, without knowing any meeting exists. Accepted for
  now, the same way ADR-0007 accepted "every question costs quota" — closed
  properly in Phase 10, not patched piecemeal here.
- **Search quality depends entirely on what has been indexed.** A meeting
  nobody indexed contributes nothing, silently, past the caption on the
  search box. This app already treats an un-indexed meeting as one where
  "nothing retrieved supports an answer" is the honest per-meeting story;
  cross-meeting search extends the same honesty rather than a false
  completeness guarantee.
- **A result's quote is a whole window, not a sentence.** Long by citation
  standards elsewhere in this app (up to `WINDOW_TOKEN_BUDGET` tokens,
  ADR-0007 decision 2) — the UI truncates for display, the API does not.
- **A weak match is not shown at all, rather than shown as if it were a real
  one.** The similarity-0 floor (decision 6) means a query with nothing
  relevant indexed anywhere returns no results, not the least-bad thing
  available — the same "empty" a per-meeting `ask` would report.
- **Demo reviewers still need to upload something first.** No seeded meeting
  ships with this phase.

## Alternatives considered

- **Full cross-meeting Q&A with one synthesized answer**: the harder, more
  valuable feature eventually, but well past what Phase 8's stated
  acceptance criteria ask for, and the biggest new source of citation risk in
  this codebase since Phase 7 itself. Deferred, not rejected.
- **No similarity floor at all**: what this phase shipped with until its own
  e2e test caught it returning a "result" for a query sharing no real topic
  with anything indexed — retrieval always ranks its top-K, regardless of
  whether the nearest thing is actually near.
- **A tuned relevance threshold above 0**: would need labelled data to tune
  against, for either embedder, that does not exist. 0 asks a much weaker and
  more defensible question: does this share any direction with the query at
  all.
- **A flat global top-K across every window**: simpler SQL, but lets one
  verbose meeting starve every other meeting's results out of an otherwise
  relevant search.
- **`ROW_NUMBER() OVER (PARTITION BY meeting_id)` for the per-meeting cap**:
  the standard-looking SQL answer, and the wrong one here — it forces a full
  materialisation of the filtered set before ranking, which a `LATERAL` join
  avoids entirely.
- **Adding HNSW now, since Phase 8 is "when it's needed" per ADR-0007**: the
  premise doesn't hold at this app's actual scale (decision 2) — deferred
  again, to whenever the corpus is large enough that exact scan measurably
  slows down, not automatically to this phase.
- **A minimal per-endpoint rate limit now**: real protection sooner, at the
  cost of building (and later replacing) a narrower version of Phase 10's
  actual work for one route.
- **Building the preloaded demo meeting now**: matches the playbook's literal
  Phase 8 step 3, but Phase 10 already owns the rest of "make the demo work
  without uploading," and splitting that across two phases serves no one.

## Addendum (2026-09-22): search has no freshness guard, and the copy claimed otherwise

A whole-system audit after this shipped found that cross-meeting search is the
only reader of the window index with **no freshness check at all**.
`askMeeting` has two — `indexStatus(...) !== 'ready'` and a per-match
content-hash re-check, both returning 409 — and decision 1 above actually
cites that machinery as a reason to defer cross-meeting Q&A. It never noticed
that plain search needs the same thing for a weaker but real reason.

Two cases, one of them live today:

- **A partly-indexed meeting returns wrong negatives.** Indexing stores each
  batch as it lands (ADR-0007 decision 5) precisely so a quota stop keeps what
  it paid for. A meeting whose indexing stopped at window 100 of 120 is
  searched over those 100 only. Search then reports no match for something
  said in the last quarter of the meeting, with no hint that it only looked at
  part of it. This needs nothing unusual — a Gemini 429 partway through is the
  most likely provider failure in the app.
- **A stale window would quote text that is no longer in the transcript.**
  `indexMeeting` deliberately keeps a window whose hash no longer matches, so
  a resumed run can reuse it; `ask` refuses such a match, search returns
  `match.text` verbatim with a deep link into the *current* transcript. Not
  reachable today — no route replaces a finished meeting's transcript, since
  `PAST_TRANSCRIPTION` blocks re-transcription for every status a meeting can
  be in once it has an index — but that invariant is undocumented and
  untested, and Phase 9's orchestration redesign is the phase most likely to
  break it.

What changed here: only the UI copy, which asserted a completeness this design
cannot deliver ("Searches only meetings indexed for questions", "No matches
found in your indexed meetings"). It now says it searched the passages indexed
so far.

What deliberately did NOT change: no freshness check was added. Detecting the
live case means knowing every meeting's index status, which costs a transcript
read plus a full window re-plan *per meeting, per search* — the whole corpus,
not just the meetings that matched, because the symptom is a meeting silently
missing from the results. That is a real design decision (an index-completeness
marker cheap enough to filter on, most likely), not a patch, and it belongs
with Phase 9's orchestration work rather than being improvised here.

## Follow-ups

- **Revisit `match_transcript_windows_across_meetings`'s access the moment
  auth exists.** It is `service_role`-only today, like every function and
  table in this schema — RLS is enabled everywhere with no policies, so there
  is nothing to scope against yet. Supabase's own documented pattern for
  exactly this shape of problem is ordinary RLS policies on the table holding
  the embeddings; that only works once the query path actually runs as the
  authenticated caller rather than a service-role connection that bypasses
  RLS by design. A "search everything" endpoint is precisely the kind of
  query that silently returns another user's data first, once there are
  other users, if this step gets forgotten.
- **Phase 9's playbook description no longer matches this app's pipeline.**
  It describes one streaming request with no queue; the real pipeline is four
  independently-invoked routes (`transcribe`, `summarize`, `search-index`,
  `ask`), each with its own claim/retry machinery, with the client polling
  rather than anything streaming. Recorded here so it is not rediscovered
  from scratch when Phase 9 starts — every earlier phase transition wrote its
  playbook/reality mismatch down (ADR-0004 through ADR-0007); this is the one
  case where that had not happened yet.
- **`node:path` is imported eagerly, not lazily, in every `*-local.ts`
  driver file** (`local.ts`, `windows-local.ts`, `transcripts-local.ts`,
  `summaries-local.ts`, `storage/local.ts`), unlike the `unstorage/drivers/fs`
  import beside it in the same files, which IS dynamic. ADR-0003 confirmed
  only the fs driver's dynamic import keeps the Cloudflare bundle from
  evaluating it; whether `node:path` itself resolves cleanly under Nitro's
  Cloudflare preset was never checked. Worth confirming ahead of Phase 13
  rather than discovering it at deploy time.
