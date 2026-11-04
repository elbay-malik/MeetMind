# ADR-0005: Audio playback over a same-origin range route, with a native player before a waveform

- **Status:** Accepted
- **Date:** 2026-09-05

## Context

Phases 3 and 4 leave compressed audio in storage and a timestamped transcript in
the database. Phase 5's goal is the pair working together: click a transcript
line to jump there, and have the line highlight and scroll as playback runs.

Two things had to be settled first, and neither is in the playbook.

**Nothing could play the audio.** The store was write-only from the browser's
point of view: upload by presigned PUT, read server-side for transcription. The
playbook assumes a player without saying how audio reaches it.

**The playbook introduces Wavesurfer in this phase and its own peaks in step 3.**
Those two instructions are in tension, and the ordering matters more than it
looks.

## Decision

### 1. Serve audio from our own origin, with byte ranges.

`GET /api/meetings/:id/audio` streams the object and honours a single byte
range, answering 206 with `Content-Range`, 416 for an unsatisfiable range, and
`Accept-Ranges: bytes` on every response.

Not a presigned URL. It would have to exist anyway for the local driver, which
the public internet cannot reach; a presigned link is a bearer capability that
outlives the page that issued it; and same-origin audio keeps Web Audio usable
later, which a cross-origin URL would foreclose permanently.

The route is unauthenticated, matching the rest of the API until an auth phase.
It grants no more than `GET /api/meetings` already does.

### 2. Range support is the whole feature, and it fails silently.

Without a valid 206 the browser reports no seekable ranges, and a seek does not
error: it snaps to the start, or the scrubber never appears. Chromium decides a
resource is seekable from either an `Accept-Ranges: bytes` header or a 206 whose
`Content-Range` parses, so the header is sent on every response rather than
relied on alone. Firefox computes `seekable` as "not compressed and accepts
ranges", so a single `Content-Encoding` anywhere disables seeking regardless of
correct range handling — hence `no-transform` on the cache header.

Parsing lives in a pure, separately tested function because every interesting
case is an edge case: open-ended and suffix forms, ends past the object,
backwards ranges, a zero-byte object. Anything unrecognised degrades to serving
the whole body, which RFC 9110 permits.

### 3. Streaming, not buffering.

Playback requests ranges repeatedly. `AudioStore.get` buffers up to 25 MB, which
is fine once per transcription and wrong several times per playback session
inside a small isolate. `openRange` streams instead: R2 passes the range through
on its signed fetch and takes the authoritative size from `Content-Range`; the
local driver reads the file with an offset.

### 4. A native audio element now. Wavesurfer with peaks, later.

The playbook asks for Wavesurfer in this phase, and its own step 3 warns against
letting the library decode the audio itself. Both cannot hold at once: without
precomputed peaks, `WaveSurfer.create({ url })` fetches the whole file and
decodes it, which for a meeting near the size cap means roughly 25 MB downloaded
and a several-hundred-megabyte audio buffer. The peaks that avoid this have to
come from the extraction pipeline, since the deploy target cannot run ffmpeg.

So this phase delivers the acceptance criteria — click-to-seek, active-line
highlight, auto-scroll, keyboard seek — against `<audio controls>`, and leaves
the waveform to follow with the peaks that make it viable. A native transport
also brings a keyboard-operable, screen-reader-labelled control for free, which
matters because Wavesurfer ships no accessibility at all: no roles, no focus
handling, and Tab skips its waveform entirely.

### 5. One tab stop for the transcript, not one per line.

Lines are buttons so they can be activated by keyboard, but a roving tabindex
keeps the whole transcript to a single tab stop with the arrow keys moving
within it. A thousand tab stops would make the page unusable by keyboard.

The active line carries `aria-current` and is not announced. Speaking every line
as playback runs would be unusable; a reader can navigate the transcript
directly instead.

## Consequences

- Playback costs several Class B operations per session rather than the one
  ADR-0003 counted, plus more when someone scrubs. Still far inside the free
  tier, but that record's cost line is now understated.
- Auto-scroll stops when the user scrolls and offers an explicit control to
  resume, which returns to where playback actually is rather than where the view
  was left. Distinguishing our own scrolling from theirs is done by comparing
  against the position we last set, not by timing: a first attempt used a
  fixed window after a smooth scroll, and any scroll animation longer than that
  window read as the user taking over, so the page stopped following itself.
  Scrolling is also confined to the transcript container, since scrolling the
  page would push the player out of view.
- There is no waveform until peaks land. That is the visible cost of the split.
- **The browser check cannot prove range support.** The committed fixture yields
  about 70 KB of audio. Chromium fetches that in one request and can then seek
  within what it already holds, so it seeks happily against a server that
  ignores Range entirely. Confirmed by breaking the route deliberately: the
  browser script still passed while five HTTP-level tests failed. Range
  correctness is guarded by `tests/e2e/audio-api.spec.ts` alone, and both
  scripts say so.

## Alternatives considered

- **Presigned GET straight to R2** — no proxy to write, and R2 handles ranges
  itself. Rejected: it does not serve the local driver, the link outlives the
  page, and cross-origin media closes the door on Web Audio.
- **A signed-token proxy, like the upload route** — more machinery for no gain
  while every other read route is open. Revisit with authentication.
- **Wavesurfer now, peaks later** — the combination the playbook implies, and the
  one its own guidance argues against. Rejected on the numbers above.
- **Virtualising the transcript** — measured as unnecessary at this scale, and it
  would complicate in-page find and auto-scroll. Left undone deliberately.

## Follow-ups

- Peaks computed during extraction, then the waveform on top of them.
- R2's range behaviour is still unverified against a real bucket, which is now
  the third record in a row to say so. `pnpm test:services` is where that lands.
- Safari cannot play Opus-in-Ogg before 18.4, and from then on lands a seek in it about 4% early.
  The demo's recording is served as MP4 for that reason (ADR-0015). An invited upload is not.
